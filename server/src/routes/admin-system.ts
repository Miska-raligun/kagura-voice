// 管理接口：在线更新、导出 / 导入备份。只许本机（同其它管理接口，走 isLocal）。
import fs from "node:fs";
import path from "node:path";
import { json, type Req, type Res, type Router } from "../http/router.ts";
import type { Ctx } from "../ctx.ts";
import { isLocal } from "./admin.ts";
import { catalog, exportBackup, inspectBackup, stageImport, backupName } from "../backup.ts";
import { restartSelf } from "../util/restart.ts";
import { VERSION } from "../cli.ts";

export const IMPORT_PATH = "/api/admin/backup/inspect";

export function registerAdminSystem(r: Router, ctx: Ctx) {
  const guard = (h: (req: Req) => Res | Promise<Res>) => async (req: Req): Promise<Res> => {
    if (!isLocal(req)) return json({ error: "管理接口只允许本机访问" }, 403);
    try { return await h(req); } catch (e: any) { return json({ error: String(e.message || e) }, e.status ?? 400); }
  };
  const upload = () => path.join(ctx.cfg.dataDir, ".import-upload.zip");

  // ── 在线更新 ──
  const updView = () => ({
    enabled: !!ctx.updates, current: VERSION, info: ctx.updates?.info ?? null,
    kind: ctx.selfUpdater?.installKind ?? "unsupported", state: ctx.selfUpdater?.state ?? null,
  });
  r.add("GET", "/api/admin/update", guard(() => json(updView())));
  r.add("POST", "/api/admin/update/check", guard(async () => {
    if (!ctx.updates) return json({ error: "更新检查已关闭（config.json 里 update_check: false）" }, 400);
    await ctx.updates.check();
    return json(updView());
  }));
  r.add("POST", "/api/admin/update/install", guard(() => {
    if (!ctx.selfUpdater) return json({ error: "不支持在线更新" }, 400);
    ctx.selfUpdater.install(ctx.updates?.info ?? null);      // 后台跑，页面轮询 /api/admin/update 看进度
    return json(updView());
  }));

  // ── 导出 ──
  r.add("GET", "/api/admin/backup/catalog", guard(() => json({ items: catalog(ctx.cfg.dataDir) })));
  r.add("POST", "/api/admin/backup/export", guard((req) => {
    const d = req.json() ?? {};
    const ids = Array.isArray(d.items) ? d.items.map(String) : [];
    if (!ids.length) return json({ error: "至少选一项" }, 400);
    const { buf, manifest } = exportBackup(ctx.cfg.dataDir, ids, { secrets: !!d.secrets, version: VERSION });
    console.log(`[backup] 📤 导出 ${manifest.items.length} 项，${(buf.length / 1048576).toFixed(1)}MB${manifest.secrets ? "（含密钥）" : ""}`);
    const name = backupName();
    return { status: 200, headers: { "Content-Type": "application/zip", "Content-Length": buf.length, "Content-Disposition": `attachment; filename="${name}"` }, body: buf };
  }));

  // ── 导入：先上传看内容，再勾选导入（写到待导入目录，重启时换进去） ──
  r.bigBodyPaths.add(IMPORT_PATH);
  r.add("POST", IMPORT_PATH, guard((req) => {
    if (!req.body.length) return json({ error: "没收到文件" }, 400);
    const man = inspectBackup(req.body);
    fs.writeFileSync(upload(), req.body);
    return json({ manifest: man });
  }));
  r.add("POST", "/api/admin/backup/import", guard((req) => {
    if (!fs.existsSync(upload())) return json({ error: "先上传备份包" }, 400);
    const ids = ((req.json() ?? {}).items ?? []).map(String);
    const res = stageImport(ctx.cfg.dataDir, fs.readFileSync(upload()), ids);
    fs.rmSync(upload(), { force: true });
    console.log(`[backup] 📥 准备导入 ${res.items.length} 项（${res.files} 个文件），重启后生效`);
    setTimeout(() => restartSelf(ctx.cfg.dataDir, null), 500);
    return json({ ...res, restarting: true });
  }));
}
