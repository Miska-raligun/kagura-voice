// 管理界面里的聊天：新建 / 接着聊任意会话，回复边生成边推给页面（NDJSON 流），可以带图片和文件。
//
// 文件：存进 agent 工作目录 uploads/<日期>/；小的文本文件把内容直接附在消息里，其它的告诉 agent 存在哪
// （它可以用 exec 处理）。图片按模型能力直接给（不支持看图的模型会收到一句说明）。
import fs from "node:fs";
import path from "node:path";
import { bytes, json, type Req, type Res, type Router } from "../http/router.ts";
import { resolveInside } from "../agent/paths.ts";
import type { AgentSystem } from "../agent/system.ts";
import { isLocal } from "./admin.ts";

const MAX_IMAGES = 6;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
/** 这么小的文本文件把内容直接放进消息 */
const INLINE_TEXT_BYTES = 64 * 1024;
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|jsonl|ya?ml|toml|ini|cfg|conf|log|xml|html?|css|js|mjs|ts|tsx|jsx|py|sh|bat|ps1|sql|java|kt|go|rs|c|h|cpp|hpp|cs|rb|php|lua|srt|vtt)$/i;

export interface Upload { name: string; b64: string }

/** 文件名只留安全的部分（保留中文），防目录穿越 */
export function safeName(name: string): string {
  const base = path.basename(String(name).replace(/\\/g, "/")).replace(/[\x00-\x1f<>:"|?*]/g, "_").replace(/^\.+/, "").trim();
  return base.slice(-120) || "file";
}

/** 存上传的文件，返回附在消息后面的说明 */
export function saveUploads(workspace: string, files: Upload[], now = new Date()): string {
  if (!files.length) return "";
  const day = now.toLocaleDateString("sv-SE");
  const dir = path.join(workspace, "uploads", day);
  fs.mkdirSync(dir, { recursive: true });
  const parts: string[] = [];
  for (const f of files) {
    const data = Buffer.from(String(f.b64 ?? ""), "base64");
    if (data.length > MAX_FILE_BYTES) throw Object.assign(new Error(`${f.name} 太大（上限 ${MAX_FILE_BYTES >> 20}MB）`), { status: 400 });
    let name = safeName(f.name);
    for (let i = 2; fs.existsSync(path.join(dir, name)); i++) name = safeName(f.name).replace(/(\.[^.]*)?$/, `-${i}$1`);
    const abs = path.join(dir, name);
    fs.writeFileSync(abs, data);
    const rel = `uploads/${day}/${name}`;
    const isText = TEXT_EXT.test(name) && !data.subarray(0, 8000).includes(0);
    if (isText && data.length <= INLINE_TEXT_BYTES) {
      parts.push(`<file name="${name}" path="${rel}">\n${data.toString("utf8")}\n</file>`);
    } else {
      parts.push(`[附件 ${name}（${(data.length / 1024).toFixed(1)}KB）已保存到你工作目录下的 ${rel}（完整路径 ${abs}）。需要看内容就用 exec 处理它。]`);
    }
  }
  return "\n\n" + parts.join("\n\n");
}

export function registerAdminChat(r: Router, sys: AgentSystem) {
  const { registry, runtime } = sys;
  const guard = (h: (req: Req) => Res | Promise<Res>) => async (req: Req): Promise<Res> => {
    if (!isLocal(req)) return json({ error: "管理接口只允许本机访问" }, 403);
    try { return await h(req); } catch (e: any) { return json({ error: String(e.message || e) }, e.status ?? 400); }
  };

  /**
   * 发一条消息：{ agent, session?, text, images?: [{data, mimeType}], files?: [{name, b64}] }。
   * session 不填 = 老的「网页聊天」会话；填一个本 agent 的会话 key 就在那个会话里接着聊（不存在就新建）。
   * ?stream=1：回 NDJSON，一行一个事件 {type:"text",delta} {type:"tool",name,args} {type:"done",reply,...} {type:"error",error}
   */
  r.add("POST", "/api/admin/chat", guard(async (req) => {
    const d = req.json() ?? {};
    const a = registry.get(String(d.agent ?? "")) ?? registry.default();
    const key = String(d.session || runtime.sessionKey(a.id, "webchat", "owner"));
    if (!key.startsWith(`${a.id}:`) || key.length > 200) return json({ error: "会话不属于这个 agent" }, 400);
    let text = String(d.text ?? "").trim();
    const images = (Array.isArray(d.images) ? d.images : []).slice(0, MAX_IMAGES).filter((i: any) => /^image\//.test(String(i?.mimeType)) && typeof i?.data === "string");
    if (images.some((i: any) => i.data.length * 0.75 > MAX_IMAGE_BYTES)) return json({ error: "图片太大" }, 400);
    const files: Upload[] = Array.isArray(d.files) ? d.files : [];
    if (!text && !images.length && !files.length) return json({ error: "消息是空的" }, 400);
    if (/^\/(reset|new)\s*$/i.test(text)) { runtime.store(a.id).reset(key); return json({ reply: "好，我们重新开始吧。", tools: [], session: key }); }
    text = (text || (images.length ? "（发来了图片）" : "（发来了文件）")) + saveUploads(a.workspace, files);
    const kind = (runtime.store(a.id).getSession(key)?.kind as any) ?? "chat";
    const reqBase = { agentId: a.id, sessionKey: key, kind, channel: "webchat", text, images: images.map((i: any) => ({ type: "image" as const, data: i.data, mimeType: i.mimeType })) };
    if (req.query.get("stream") !== "1") {
      const res = await runtime.run(reqBase);
      // 网页聊天的回复同样交给出口顺带念（和飞书私聊同一套判断）
      void sys.mirror?.(a.id, res.text, "webchat", res.meta);
      return json({ reply: res.text, tools: res.toolCalls, usage: res.usage, session: key });
    }
    return {
      status: 200, headers: {}, body: "",
      raw: async (res) => {
        res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" });
        const send = (o: unknown) => { if (!res.writableEnded) res.write(JSON.stringify(o) + "\n"); };
        try {
          const out = await runtime.run({
            ...reqBase,
            onEvent: (e) => {
              if (e.type === "text") send({ type: "text", delta: e.delta });
              else if (e.type === "tool_start") send({ type: "tool", name: e.name, args: e.args });
              else if (e.type === "message_end" && e.toolCalls) send({ type: "break" });
            },
          });
          send({ type: "done", reply: out.text, tools: out.toolCalls, usage: out.usage, session: key });
          // 流式回复也一样
          void sys.mirror?.(a.id, out.text, "webchat", out.meta);
        } catch (e: any) {
          send({ type: "error", error: String(e.message || e) });
        }
        res.end();
      },
    };
  }));

  /** 会话里引用的图片 / 上传的文件（只认工作目录 uploads/ 下的） */
  r.add("GET", "/api/admin/agents/<id>/uploads", guard((req) => {
    const a = registry.get(req.params.id);
    if (!a) return json({ error: `没有 agent ${req.params.id}` }, 404);
    const rel = String(req.query.get("path") ?? "");
    if (!rel.startsWith("uploads/")) return json({ error: "只能取 uploads/ 下的文件" }, 400);
    const f = resolveInside(a.workspace, rel);
    if (!fs.existsSync(f) || !fs.statSync(f).isFile()) return json({ error: "没有这个文件" }, 404);
    const ext = path.extname(f).toLowerCase();
    const mime = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif" }[ext] ?? "application/octet-stream";
    return bytes(fs.readFileSync(f), mime, { "Cache-Control": "max-age=86400", ...(mime === "application/octet-stream" ? { "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(f))}` } : {}) });
  }));

  r.add("DELETE", "/api/admin/agents/<id>/sessions/<key>", guard((req) => {
    const a = registry.get(req.params.id);
    if (!a) return json({ error: `没有 agent ${req.params.id}` }, 404);
    if (runtime.busy(a.id, req.params.key)) return json({ error: "这个会话正在回复，等它说完再删" }, 409);
    return runtime.store(a.id).remove(req.params.key) ? json({ status: "ok" }) : json({ error: "没有这个会话" }, 404);
  }));
}
