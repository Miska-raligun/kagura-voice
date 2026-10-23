// 触觉：X-Touch 体感摘要 → 中文背景句（对应 voice_server._touch_phrases 等）。
// 走请求头而不是单独的路由，是为了不额外占一次 LLM 调用——体感是背景，不是事件。
const TOUCH_MAX_HEADER = 200;

export function touchPhrases(raw: string): string[] {
  if (!raw || raw.length > TOUCH_MAX_HEADER) return [];
  const vals: Record<string, number> = {};
  for (const item of raw.split(",")) {
    const i = item.indexOf("=");
    const k = (i < 0 ? item : item.slice(0, i)).trim();
    const v = i < 0 ? "" : item.slice(i + 1).trim();
    if (/^[+-]?\d+$/.test(v)) vals[k] = parseInt(v, 10);
  }
  const out: string[] = [];
  const secs = vals.stroke ?? 0;
  if (secs > 0) {
    const n = vals.strokes ?? 1;
    out.push(n > 1 ? `刚才用户摸了你 ${n} 次，一共约 ${secs} 秒` : `刚才用户摸了你大约 ${secs} 秒`);
  }
  if ((vals.cradles ?? 0) > 0) out.push("用户把手掌整个覆在你身上，像捧着你");
  if ((vals.taps ?? 0) > 0) out.push(`用户轻拍了你的机身 ${vals.taps} 下`);
  if ((vals.pickups ?? 0) > 0) out.push("用户把你从桌上拿起来过");
  if ((vals.carry ?? 0) >= 5) out.push(`你被端在手上移动了约 ${vals.carry} 秒`);
  const quiet = vals.quiet ?? 0;
  if (quiet > 0) out.push(`在此之前已经 ${Math.floor(quiet / 60)} 分钟没有人碰过你`);
  return out;
}

export function touchBackground(raw: string): string {
  const p = touchPhrases(raw);
  return p.length ? "[身体感觉：" + p.join("；") + "]" : "";
}

export function withTouch(text: string, raw: string): string {
  const bg = touchBackground(raw);
  return bg ? `${bg}\n${text}` : text;
}

export const TOUCH_KIND_DESC: Record<string, string> = {
  stroke: "用户正在摸你——手指贴着你的屏幕慢慢滑过",
  cradle: "用户把手整个覆在你身上，像是把你捧在手里",
  tap: "用户轻轻拍了拍你的机身，像在叫你",
  pickup: "用户把你从桌上拿了起来，你现在在她手里",
};
