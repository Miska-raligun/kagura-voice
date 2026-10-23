// 新版本提醒：定时查 GitHub Releases，有更新就在管理界面总览和 IM 的 /status 里提示（不会自动下载安装）。
// 当前是预览版（带 -rc / -beta）就连预览版一起比；正式版只提示正式版。config.json 写 "update_check": false 可关掉。
import semver from "semver";

export const RELEASES_API = "https://api.github.com/repos/Miska-raligun/kagura-voice/releases?per_page=30";
export interface UpdateInfo { current: string; latest: string; url: string; notes: string; publishedAt: string; checkedAt: number; newer: boolean; error?: string }

export function pickLatest(current: string, releases: any[]): { tag: string; url: string; notes: string; publishedAt: string } | null {
  const pre = !!semver.prerelease(current);
  const ok = releases
    .filter((r) => !r.draft && semver.valid(String(r.tag_name ?? "").replace(/^v/, "")))
    .map((r) => ({ v: String(r.tag_name).replace(/^v/, ""), r }))
    .filter((x) => pre || !semver.prerelease(x.v))
    .sort((a, b) => semver.rcompare(a.v, b.v));
  const top = ok[0];
  return top ? { tag: top.v, url: top.r.html_url ?? "", notes: String(top.r.body ?? "").slice(0, 800), publishedAt: top.r.published_at ?? "" } : null;
}

export class UpdateChecker {
  info: UpdateInfo | null = null;
  private timer: NodeJS.Timeout | null = null;
  constructor(private current: string, private fetchFn: typeof fetch = fetch, private url = RELEASES_API) {}

  async check(): Promise<UpdateInfo | null> {
    if (!semver.valid(this.current)) return null;          // 开发版（dev）不查
    try {
      const r = await this.fetchFn(this.url, { headers: { accept: "application/vnd.github+json", "user-agent": "kagura" }, signal: AbortSignal.timeout(15_000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const top = pickLatest(this.current, (await r.json()) as any[]);
      if (!top) return this.info;
      this.info = { current: this.current, latest: top.tag, url: top.url, notes: top.notes, publishedAt: top.publishedAt, checkedAt: Date.now() / 1000, newer: semver.gt(top.tag, this.current) };
      if (this.info.newer) console.log(`[update] 🆕 有新版本 ${top.tag}（当前 ${this.current}）：${top.url}`);
    } catch (e: any) {
      this.info = { ...(this.info ?? { current: this.current, latest: "", url: "", notes: "", publishedAt: "", newer: false }), checkedAt: Date.now() / 1000, error: String(e.message) };
    }
    return this.info;
  }

  /** 启动 30 秒后查一次，之后每 12 小时一次 */
  start() {
    setTimeout(() => { this.check(); }, 30_000).unref();
    this.timer = setInterval(() => { this.check(); }, 12 * 3600_000);
    this.timer.unref();
  }

  /** 给 /status 之类用的一行 */
  line(): string {
    return this.info?.newer ? `有新版本 ${this.info.latest}（当前 ${this.info.current}）：${this.info.url}` : "";
  }
}
