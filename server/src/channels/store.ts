// 渠道的配置与状态落 <数据目录>/channels.json：账号、聊天→agent 绑定、白名单（含主人标记）、配对申请。
// 数据量很小，整文件原子写。凭据也在这里——管理接口读出时打码。
import fs from "node:fs";
import crypto from "node:crypto";
import type { AccountConfig, ChannelKind } from "./types.ts";

export interface Binding { account: string; chatId: string; agent: string; label?: string }
export interface Allowed { account: string; user: string; name?: string; owner?: boolean; since: number }
export interface Pairing { account: string; user: string; name?: string; code: string; chatId: string; ts: number }

interface Data { accounts: AccountConfig[]; bindings: Binding[]; allowed: Allowed[]; pairings: Pairing[] }

const ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const KINDS: ChannelKind[] = ["feishu", "qq", "onebot"];
const PAIRING_TTL = 24 * 3600;

export function normalizeAccount(raw: any, prev?: AccountConfig): AccountConfig {
  const id = String(raw.id ?? prev?.id ?? "");
  if (!ID_RE.test(id)) throw new Error("账号 id 只能用字母/数字/_-");
  const kind = (raw.kind ?? prev?.kind) as ChannelKind;
  if (!KINDS.includes(kind)) throw new Error(`渠道类型只能是 ${KINDS.join(" / ")}`);
  const pick = <T>(k: string, d: T): T => (raw[k] !== undefined ? raw[k] : (prev as any)?.[k] ?? d);
  const dm = pick("dm_policy", "pairing");
  const gp = pick("group_policy", "mention");
  if (!["pairing", "allowlist", "open"].includes(dm)) throw new Error("dm_policy 只能是 pairing / allowlist / open");
  if (!["mention", "all", "off"].includes(gp)) throw new Error("group_policy 只能是 mention / all / off");
  const vp = pick("voice_push", "home");
  if (!["home", "always", "off"].includes(vp)) throw new Error("voice_push 只能是 home / always / off");
  // 凭据：传了就逐项覆盖；传 "***" 表示「保持原值」（管理界面回显的是打码值）
  const creds: Record<string, string> = { ...(prev?.credentials ?? {}) };
  for (const [k, v] of Object.entries(raw.credentials ?? {})) if (v !== "***") creds[k] = String(v);
  return {
    id, kind, name: String(pick("name", id)), enabled: !!pick("enabled", true), credentials: creds,
    agent: String(pick("agent", "")), dm_policy: dm, group_policy: gp,
    owner_main: !!pick("owner_main", false), daily_limit: Math.max(0, Number(pick("daily_limit", 200)) || 0),
    voice_push: vp,
  };
}

export class ChannelStore {
  private d: Data = { accounts: [], bindings: [], allowed: [], pairings: [] };

  constructor(private file: string) {
    try { this.d = { ...this.d, ...JSON.parse(fs.readFileSync(file, "utf8")) }; }
    catch (e: any) { if (e.code !== "ENOENT") console.log(`[channel] ⚠️  channels.json 读取失败: ${e.message}`); }
  }

  private save() {
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.d, null, 2));
    fs.renameSync(tmp, this.file);
  }

  accounts() { return [...this.d.accounts]; }
  account(id: string) { return this.d.accounts.find((a) => a.id === id); }

  upsertAccount(raw: any): AccountConfig {
    const prev = this.account(String(raw.id ?? ""));
    const a = normalizeAccount(raw, prev);
    this.d.accounts = prev ? this.d.accounts.map((x) => (x.id === a.id ? a : x)) : [...this.d.accounts, a];
    this.save();
    return a;
  }

  removeAccount(id: string) {
    const n = this.d.accounts.length;
    this.d.accounts = this.d.accounts.filter((a) => a.id !== id);
    this.d.bindings = this.d.bindings.filter((b) => b.account !== id);
    this.d.allowed = this.d.allowed.filter((b) => b.account !== id);
    this.d.pairings = this.d.pairings.filter((b) => b.account !== id);
    this.save();
    return this.d.accounts.length < n;
  }

  /** 打码的账号视图（给管理接口） */
  masked(a: AccountConfig) {
    return { ...a, credentials: Object.fromEntries(Object.entries(a.credentials).map(([k, v]) => [k, /secret|token|key|password/i.test(k) && v ? "***" : v])) };
  }

  // ── 绑定 ──
  bindings() { return [...this.d.bindings]; }
  binding(account: string, chatId: string) { return this.d.bindings.find((b) => b.account === account && b.chatId === chatId); }
  bind(b: Binding) {
    this.d.bindings = this.d.bindings.filter((x) => !(x.account === b.account && x.chatId === b.chatId));
    if (b.agent) this.d.bindings.push(b);
    this.save();
  }

  // ── 白名单 / 配对 ──
  allowed() { return [...this.d.allowed]; }
  isAllowed(account: string, user: string) { return this.d.allowed.find((x) => x.account === account && x.user === user); }
  allow(account: string, user: string, name?: string, owner = false) {
    this.d.allowed = this.d.allowed.filter((x) => !(x.account === account && x.user === user));
    this.d.allowed.push({ account, user, name, owner, since: Date.now() / 1000 });
    this.d.pairings = this.d.pairings.filter((p) => !(p.account === account && p.user === user));
    this.save();
  }
  disallow(account: string, user: string) {
    this.d.allowed = this.d.allowed.filter((x) => !(x.account === account && x.user === user));
    this.save();
  }

  pairings() {
    const t = Date.now() / 1000;
    return this.d.pairings.filter((p) => t - p.ts < PAIRING_TTL);
  }

  /** 陌生人第一次来：发一个配对码（同一人 24 小时内复用同一个码） */
  requestPairing(account: string, user: string, chatId: string, name?: string): Pairing {
    const cur = this.pairings().find((p) => p.account === account && p.user === user);
    if (cur) return cur;
    const p: Pairing = { account, user, name, chatId, code: crypto.randomInt(0, 1e6).toString().padStart(6, "0"), ts: Date.now() / 1000 };
    this.d.pairings = [...this.pairings(), p];
    this.save();
    return p;
  }

  /** 批准配对（管理界面按码或按用户批准）。返回被批准的申请 */
  approve(account: string, codeOrUser: string): Pairing | null {
    const p = this.pairings().find((x) => x.account === account && (x.code === codeOrUser || x.user === codeOrUser));
    if (!p) return null;
    this.allow(account, p.user, p.name);
    return p;
  }

  rejectPairing(account: string, user: string) {
    this.d.pairings = this.d.pairings.filter((p) => !(p.account === account && p.user === user));
    this.save();
  }
}
