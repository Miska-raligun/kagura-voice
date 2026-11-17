// 每日笔记也用起来：自动回忆会看 2~14 天前的笔记（标上日期、跳过后台流水）。不往长期记忆里提炼（主人：会膨胀、污染长期记忆）
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { makeRuntime } from "./helpers.ts";
import { dailyNotePath } from "../src/agent/soul.ts";
import { Memories } from "../src/agent/tools/memory.ts";

const DAY = 86400_000;
const ymd = (t: number) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
function setup() {
  const env = makeRuntime();
  const a = env.reg.get("main")!;
  const note = (daysAgo: number, lines: string[]) => {
    const p = dailyNotePath(a.workspace, new Date(Date.now() - daysAgo * DAY));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, `# ${ymd(Date.now() - daysAgo * DAY)}\n\n${lines.map((l) => `- ${l}`).join("\n")}\n`);
    return ymd(Date.now() - daysAgo * DAY);
  };
  fs.writeFileSync(path.join(a.workspace, "MEMORY.md"), "# 长期记忆\n- 家里的猫叫团子\n");
  return { ...env, a, mem: new Memories(env.rt, null), ws: a.workspace, note };
}

describe("自动回忆看每日笔记", () => {
  it("2~14 天前的笔记能想起来，最多 2 条；今天 / 昨天的（已经在提示里）和更早的不算；后台流水跳过", async () => {
    const env = setup();
    env.note(0, ["10:00 主人说滑雪板放在车库"]);
    env.note(1, ["10:00 主人说滑雪板借给了小王"]);
    env.note(5, ["10:00 主人说滑雪板的固定器松了，要拿去修", "11:00 [heartbeat] 滑雪板 例行检查没事"]);
    env.note(9, ["20:00 主人说滑雪板是 2024 年买的"]);
    env.note(30, ["20:00 主人说滑雪板很贵"]);
    const hits = await env.mem.of("main").recallDaily("我的滑雪板怎么了");
    expect(hits.length).toBeLessThanOrEqual(2);
    const all = hits.map((h) => h.text).join("\n");
    expect(all).toContain("固定器松了");
    expect(all).not.toContain("车库");
    expect(all).not.toContain("小王");
    expect(all).not.toContain("很贵");
    expect(all).not.toContain("heartbeat");
    expect(hits.every((h) => h.path.startsWith("memory/"))).toBe(true);
  });

});

