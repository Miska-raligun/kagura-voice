// util/nodefetch.ts：在线更新的大文件下载不走 undici（对方断开 + 背压会让 undici 抛未捕获异常）
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { makeNodeFetch } from "../src/util/nodefetch.ts";

const BIG = Buffer.alloc(8 * 1024 * 1024);
for (let i = 0; i < BIG.length; i++) BIG[i] = i % 253;
let server: http.Server, proxy: http.Server, base = "", proxyUrl = "", proxied = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/redir") { res.writeHead(302, { location: "/file" }); res.end(); return; }
    const m = /bytes=(\d+)-/.exec(String(req.headers.range ?? ""));
    const start = m ? Number(m[1]) : 0;
    // 像 python http.server 一样：HTTP/1.0 风格，发完就断开
    res.writeHead(m ? 206 : 200, { "content-length": BIG.length - start, connection: "close" });
    res.end(BIG.subarray(start));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  // 最简 HTTP 代理（只转发 http 目标）
  proxy = http.createServer((req, res) => {
    proxied++;
    // 不管请求的是哪个主机，都转给本地测试服务器
    const u = new URL(req.url!), t = new URL(base);
    const up = http.request({ hostname: t.hostname, port: t.port, path: u.pathname, headers: req.headers }, (r) => { res.writeHead(r.statusCode!, r.headers); r.pipe(res); });
    up.once("error", () => { res.writeHead(502); res.end(); });
    up.end();
  });
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
  proxyUrl = `http://127.0.0.1:${(proxy.address() as any).port}`;
});
afterAll(() => { server.close(); proxy.close(); });

async function slowRead(r: Response) {
  let n = 0;
  for await (const c of r.body as any as AsyncIterable<Uint8Array>) { n += c.length; await new Promise((s) => setTimeout(s, 2)); }
  return n;
}

describe("nodefetch", () => {
  it("对方发完就断开、我们读得很慢：完整收到，不崩", async () => {
    const f = makeNodeFetch();
    const r = await f(`${base}/file`);
    expect(r.status).toBe(200);
    expect(await slowRead(r)).toBe(BIG.length);
  });

  it("跟随重定向；Range 续传返回 206", async () => {
    const f = makeNodeFetch();
    const r = await f(`${base}/redir`, { headers: { range: "bytes=1000-" } });
    expect(r.status).toBe(206);
    const got = Buffer.from(await r.arrayBuffer());
    expect(got.equals(BIG.subarray(1000))).toBe(true);
  });

  it("配了代理走代理，本机地址不走", async () => {
    proxied = 0;
    const f = makeNodeFetch(() => proxyUrl);
    await (await f(`${base}/file`)).arrayBuffer();
    expect(proxied).toBe(0);                                     // 127.0.0.1 直连
    const r = await f(`http://downloads.example.test/file`);    // 非本机地址交给代理
    expect(Buffer.from(await r.arrayBuffer()).equals(BIG)).toBe(true);
    expect(proxied).toBe(1);
  });

  it("中途取消", async () => {
    const ac = new AbortController();
    const f = makeNodeFetch();
    const r = await f(`${base}/file`, { signal: ac.signal });
    ac.abort();
    await expect(slowRead(r)).rejects.toThrow();
  });
});
