// 大文件下载用的 fetch：底层是 Node 自带的 http / https，不走 undici。
//
// 为什么：undici（Node 内置 fetch 的底层）在「对方不保持连接（Connection: close / HTTP/1.0）+ 我们写盘慢、
// 接收被背压暂停」时，对方一断开就在 socket 的 end 事件里 assert(!this.paused) 失败——这是个未捕获异常，
// 整个进程直接没了（在线更新下载到最后就这样消失，CI 冒烟抓到的堆栈：Parser.finish ← onHttpSocketEnd，undici 7/8 都在）。
// Node 的 http 模块背压走流的 pause/resume，没有这个问题。
//
// 只实现下载需要的那点：GET、跟随重定向、Range 等请求头、AbortSignal、HTTP 代理（https 目标走 CONNECT 隧道）。
// 返回标准 Response，调用方不用改。
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { Readable } from "node:stream";

const LOCAL = /^(localhost|127\.\d+\.\d+\.\d+|::1|\[::1\])$/i;

/** HTTPS 目标经 HTTP 代理：先 CONNECT 打隧道，再在上面握 TLS */
function tunnel(proxy: URL, target: URL, signal?: AbortSignal): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const port = target.port || "443";
    const auth = proxy.username ? { "proxy-authorization": `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}` } : {};
    const req = http.request({ host: proxy.hostname, port: proxy.port || 80, method: "CONNECT", path: `${target.hostname}:${port}`, headers: { host: `${target.hostname}:${port}`, ...auth }, signal });
    req.once("connect", (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); reject(new Error(`代理拒绝连接：HTTP ${res.statusCode}`)); return; }
      const s = tls.connect({ socket, servername: target.hostname }, () => resolve(s));
      s.once("error", reject);
    });
    req.once("error", reject);
    req.end();
  });
}

function once(url: URL, headers: Record<string, string>, proxy: string, signal?: AbortSignal): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const useProxy = !!proxy && !LOCAL.test(url.hostname);
    const go = (opts: http.RequestOptions, mod: typeof http | typeof https) => {
      const req = mod.request({ ...opts, headers: { ...headers, ...(opts.headers ?? {}) }, signal }, resolve);
      req.once("error", reject);
      req.end();
    };
    if (!useProxy) {
      go({ protocol: url.protocol, hostname: url.hostname, port: url.port, path: url.pathname + url.search, method: "GET", agent: false }, url.protocol === "https:" ? https : http);
      return;
    }
    const p = new URL(proxy.includes("://") ? proxy : `http://${proxy}`);
    if (url.protocol === "http:") {
      // http 目标：直接把完整 URL 发给代理
      const auth = p.username ? { "proxy-authorization": `Basic ${Buffer.from(`${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`).toString("base64")}` } : {};
      go({ hostname: p.hostname, port: p.port || 80, path: url.href, method: "GET", headers: { host: url.host, ...auth }, agent: false }, http);
      return;
    }
    tunnel(p, url, signal).then((sock) => {
      go({ hostname: url.hostname, port: url.port, path: url.pathname + url.search, method: "GET", agent: false, createConnection: () => sock } as any, https);
    }, reject);
  });
}

/** fetch 的子集（只 GET），给在线更新下载用。proxy() 每次调用时取当前代理设置 */
export function makeNodeFetch(proxy: () => string = () => ""): typeof fetch {
  return (async (input: any, init: RequestInit = {}) => {
    let url = new URL(String(input));
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => { headers[k] = v; });
    const signal = init.signal ?? undefined;
    for (let hop = 0; ; hop++) {
      const res = await once(url, headers, proxy(), signal);
      const loc = res.headers.location;
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && loc) {
        res.resume();                                   // 丢掉重定向的响应体
        if (hop >= 5) throw new Error("重定向次数太多");
        url = new URL(loc, url);
        continue;
      }
      const h = new Headers();
      for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) h.set(k, Array.isArray(v) ? v.join(", ") : String(v));
      const status = res.statusCode ?? 0;
      const body = status === 204 || status === 304 ? null : (Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>);
      return new Response(body, { status, statusText: res.statusMessage, headers: h });
    }
  }) as typeof fetch;
}
