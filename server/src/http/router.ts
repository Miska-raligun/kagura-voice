// 极简 HTTP 路由：够用即可，不引入框架（打包体积、依赖面都更小）。
// 路由写法与 Flask 一致：/capture-result/<request_id>
import http from "node:http";
import fs from "node:fs";

const MAX_BODY = 8 * 1024 * 1024;   // 比业务上限（5MB 音频/图片 base64）略大，超过直接 413
/** 少数本机接口（导入备份包、上传扩展包）要收大文件：只对本机来源放宽 */
const BIG_BODY = 1024 * 1024 * 1024;
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export class Req {
  readonly path: string;
  readonly query: URLSearchParams;
  params: Record<string, string> = {};
  constructor(readonly raw: http.IncomingMessage, readonly body: Buffer) {
    const u = new URL(raw.url || "/", "http://x");
    this.path = decodeURIComponent(u.pathname);
    this.query = u.searchParams;
  }
  get method() { return this.raw.method || "GET"; }
  /** 请求头（不区分大小写）；没有返回空串 */
  header(name: string): string {
    const v = this.raw.headers[name.toLowerCase()];
    return Array.isArray(v) ? v[0] : (v ?? "");
  }
  hasHeader(name: string) { return this.raw.headers[name.toLowerCase()] !== undefined; }
  get remoteAddr() { return this.raw.socket.remoteAddress || "unknown"; }
  /** 等价 Flask request.get_json(silent=True)：解析失败或不是 JSON 返回 null */
  json(): any {
    if (!this.body.length) return null;
    try { return JSON.parse(this.body.toString("utf8")); } catch { return null; }
  }
}

export interface Res {
  status: number;
  headers: Record<string, string | number>;
  body: Buffer | string;
  /** 响应发完后执行（例如推送音频下载即删） */
  after?: () => void;
  /** 自己接管原始响应（边生成边播：先发头、再一段段写音频）。设了它就忽略 status/headers/body */
  raw?: (res: http.ServerResponse) => Promise<void>;
}

export const json = (obj: unknown, status = 200): Res => ({
  status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj),
});

export const bytes = (body: Buffer, mime: string, extra: Record<string, string | number> = {}, status = 200): Res => ({
  status, headers: { "Content-Type": mime, "Content-Length": body.length, ...extra }, body,
});

export const file = (p: string, mime: string, extra: Record<string, string | number> = {}): Res =>
  bytes(fs.readFileSync(p), mime, extra);

export const empty = (status: number): Res => ({ status, headers: {}, body: "" });

type Handler = (req: Req) => Res | Promise<Res>;
interface Route { method: string; re: RegExp; keys: string[]; handler: Handler }

export class Router {
  private routes: Route[] = [];
  /** 允许大请求体的路径（只对本机来源生效） */
  bigBodyPaths = new Set<string>();

  add(method: string, pattern: string, handler: Handler): this {
    const keys: string[] = [];
    const re = new RegExp("^" + pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace(/<([a-z_]+)>/g, (_, k) => { keys.push(k); return "([^/]+)"; }) + "$");
    this.routes.push({ method, re, keys, handler });
    return this;
  }
  get(p: string, h: Handler) { return this.add("GET", p, h); }
  post(p: string, h: Handler) { return this.add("POST", p, h); }

  async dispatch(req: Req): Promise<Res> {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.re.exec(req.path);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== req.method) continue;
      r.keys.forEach((k, i) => (req.params[k] = m[i + 1]));
      return r.handler(req);
    }
    return pathMatched ? json({ error: "method not allowed" }, 405) : json({ error: "not found" }, 404);
  }

  listen(port: number, host = "0.0.0.0"): Promise<http.Server> {
    const server = http.createServer((rawReq, rawRes) => {
      const chunks: Buffer[] = [];
      let size = 0, tooBig = false;
      const limit = this.bigBodyPaths.has((rawReq.url || "").split("?")[0]) && LOOPBACK.has(rawReq.socket.remoteAddress || "") ? BIG_BODY : MAX_BODY;
      rawReq.on("data", (c: Buffer) => {
        size += c.length;
        if (size > limit) { tooBig = true; return; }
        chunks.push(c);
      });
      rawReq.on("end", async () => {
        let res: Res;
        if (tooBig) res = json({ error: "请求体过大" }, 413);
        else {
          try {
            res = await this.dispatch(new Req(rawReq, Buffer.concat(chunks)));
          } catch (e: any) {
            console.log(`[http] ⚠️  ${rawReq.method} ${rawReq.url} 未处理异常: ${e?.stack || e}`);
            res = json({ error: String(e?.message || e) }, 500);
          }
        }
        if (res.raw) {
          try { await res.raw(rawRes); }
          catch (e: any) {
            console.log(`[http] ⚠️  ${rawReq.method} ${rawReq.url} 流式响应出错: ${e?.message || e}`);
            if (!rawRes.headersSent) rawRes.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: String(e?.message || e) }));
            else rawRes.end();
          }
          return;
        }
        rawRes.writeHead(res.status, res.headers);
        rawRes.end(res.body, () => res.after?.());
      });
    });
    server.keepAliveTimeout = 5000;
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => resolve(server));
    });
  }
}
