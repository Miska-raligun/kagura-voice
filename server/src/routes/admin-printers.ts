// 管理接口：3D 打印机（配置、连接状态、原始数据、测试通知）。只许本机。访问码只进不出。
import { json, type Req, type Res, type Router } from "../http/router.ts";
import type { AgentSystem } from "../agent/system.ts";
import { isLocal } from "./admin.ts";

export function registerAdminPrinters(r: Router, sys: AgentSystem) {
  const guard = (h: (req: Req) => Res | Promise<Res>) => async (req: Req): Promise<Res> => {
    if (!isLocal(req)) return json({ error: "管理接口只允许本机访问" }, 403);
    if (!sys.printers) return json({ error: "打印机模块没有启用" }, 503);
    try { return await h(req); } catch (e: any) { return json({ error: String(e.message || e) }, e.status ?? 400); }
  };
  const hub = () => sys.printers!;
  const list = () => ({ printers: hub().view(), agents: sys.registry.list().map((a) => ({ id: a.id, name: a.name })) });

  r.add("GET", "/api/admin/printers", guard(() => json(list())));
  r.add("POST", "/api/admin/printers", guard((req) => { hub().upsert({ ...(req.json() ?? {}), id: "" }); return json(list()); }));
  r.add("PUT", "/api/admin/printers/<id>", guard((req) => {
    if (!hub().configs().some((p) => p.id === req.params.id)) return json({ error: "没有这台打印机" }, 404);
    hub().upsert({ ...(req.json() ?? {}), id: req.params.id });
    return json(list());
  }));
  r.add("DELETE", "/api/admin/printers/<id>", guard((req) => { hub().remove(req.params.id); return json(list()); }));
  r.add("POST", "/api/admin/printers/<id>/reconnect", guard((req) => { hub().reconnect(req.params.id); return json(list()); }));
  // 证书变了（恢复出厂 / 换机器）之后主人确认：忘掉旧指纹重连
  r.add("POST", "/api/admin/printers/<id>/retrust", guard((req) => { hub().retrust(req.params.id); return json(list()); }));
  // 打印机发来的原始状态（并好的）：字段对不上时照着它改解析
  r.add("GET", "/api/admin/printers/<id>/raw", guard((req) => {
    const p = hub().conn(req.params.id);
    return p ? json({ raw: p.raw, last_seen: p.lastSeen ? Math.round(p.lastSeen / 1000) : 0 }) : json({ error: "这台打印机没在连接" }, 404);
  }));
  // 发一条测试通知：不用真打一件东西就能确认通知会送到哪
  r.add("POST", "/api/admin/printers/<id>/test-notify", guard(async (req) => {
    const p = hub().configs().find((x) => x.id === req.params.id);
    if (!p) return json({ error: "没有这台打印机" }, 404);
    const to = await sys.printerNotify!(p.id, `这是 ${p.name} 的测试通知：打完、失败、暂停的时候我会这样告诉你。`);
    return json({ delivered: to });
  }));
}
