// 复刻过的 MiniMax 音色清单（<数据目录>/minimax_voices.json）：复刻时记一笔，激活了再记一笔。
// MiniMax 的查询接口只返回「已经正式合成过」的复刻音色，没激活的查不到、7 天后还会被删——所以本地必须自己记，
// 管理界面再和远端列表合并显示。
import fs from "node:fs";

export interface ClonedVoice {
  voice_id: string;
  /** 在哪个服务商下复刻的（speech.providers 的 id） */
  provider: string;
  /** 自己起的名字，方便认 */
  name?: string;
  created_at: number;
  /** 用按量计费 Key 正式合成过（付了音色费）的时刻 */
  activated_at?: number;
  /** 复刻时的试听链接（MiniMax 给的，有时效） */
  demo_audio?: string;
}

/** MiniMax：复刻后 7 天内没正式合成就删 */
export const CLONE_EXPIRE_MS = 7 * 24 * 3600_000;

export class ClonedVoices {
  constructor(private file: string) {}

  list(): ClonedVoice[] {
    try {
      const v = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return Array.isArray(v) ? v.filter((x) => x && typeof x.voice_id === "string") : [];
    } catch { return []; }
  }

  private save(list: ClonedVoice[]) {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
    fs.renameSync(tmp, this.file);
  }

  /** 同一个 voice_id 再来一次就覆盖（比如被删了又用同名复刻） */
  add(v: ClonedVoice) { this.save([...this.list().filter((x) => x.voice_id !== v.voice_id), v]); }

  update(voiceId: string, patch: Partial<Omit<ClonedVoice, "voice_id">>) {
    const list = this.list();
    const i = list.findIndex((x) => x.voice_id === voiceId);
    if (i < 0) return false;
    list[i] = { ...list[i], ...patch };
    this.save(list);
    return true;
  }

  remove(voiceId: string) { this.save(this.list().filter((x) => x.voice_id !== voiceId)); }

  /** 本地记录 + MiniMax 远端已激活列表合并成一张表；远端有的顺手标成已激活 */
  merge(provider: string, remote: { voice_id: string; created_time: string }[] | null, now = Date.now()) {
    const local = this.list().filter((v) => v.provider === provider);
    const remoteIds = new Set((remote ?? []).map((r) => r.voice_id));
    for (const v of local) if (remote && remoteIds.has(v.voice_id) && !v.activated_at) { v.activated_at = now; this.update(v.voice_id, { activated_at: now }); }
    const rows = local.map((v) => ({
      ...v,
      status: v.activated_at ? "active" : now - v.created_at > CLONE_EXPIRE_MS ? "expired" : "pending",
      expires_at: v.activated_at ? null : v.created_at + CLONE_EXPIRE_MS,
      in_remote: remote ? remoteIds.has(v.voice_id) : null,
    }));
    // 远端有、本地没记的（以前在别处复刻的）也列出来
    for (const r of remote ?? []) {
      if (!local.some((v) => v.voice_id === r.voice_id)) {
        rows.push({ voice_id: r.voice_id, provider, name: "", created_at: Date.parse(r.created_time) || 0, status: "active", expires_at: null, in_remote: true, activated_at: undefined });
      }
    }
    return rows.sort((a, b) => b.created_at - a.created_at);
  }
}
