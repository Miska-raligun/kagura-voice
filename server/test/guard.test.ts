// 单轮上限：兜圈子调工具时先叫停让她汇报，还不停就强制中止；同参数反复调用直接拒绝
import { describe, it, expect } from "vitest";
import { Type } from "@earendil-works/pi-ai";
import { makeRuntime } from "./helpers.ts";
import { ok } from "../src/agent/tools/device.ts";

const dev = { kind: "main" as const, channel: "device", trusted: true, agentId: "main", sessionKey: "main:main" };

function setup() {
  const env = makeRuntime();
  const ran: any[] = [];
  env.rt.addTools(() => [{
    name: "spin", label: "试试", description: "再试一次", parameters: Type.Object({ n: Type.Optional(Type.Number()) }),
    execute: async (_id: string, p: any) => { ran.push(p.n); return ok("还是不行"); },
  } as any]);
  return { ...env, ran };
}
/** n 次连续工具调用（参数各不相同），最后接 end */
const chain = (n: number, end: any, same = false): any => {
  let step = end;
  for (let i = n; i >= 1; i--) step = { tool_calls: [{ name: "spin", args: { n: same ? 0 : i } }], then: step };
  return step;
};

describe("单轮上限", () => {
  it("工具调用超过上限：叫停后她写汇报就照常回复", async () => {
    const { rt, fake, ran } = setup();
    rt.setLimits({ maxToolCalls: 5 });
    fake.queue.push(chain(7, "做到第五步了，卡在权限上"));
    const r = await rt.run({ ...dev, text: "帮我修一下" });
    expect(r.text).toBe("做到第五步了，卡在权限上");
    expect(ran).toEqual([1, 2, 3, 4, 5]);
    const tr = rt.store("main").history("main:main").map((h) => h.msg as any).filter((m) => m.role === "toolResult").at(-1);
    // 存进历史的不是那句「不要再调用任何工具」（只对那一轮有效，留着下一轮她会不敢动）
    expect(tr.content[0].text).toContain("现在是新的一轮");
  });

  it("叫停之后还在调工具：强制中止，不再烧 token", async () => {
    const { rt, fake, ran } = setup();
    rt.setLimits({ maxToolCalls: 5 });
    fake.queue.push(chain(50, "永远到不了这"));
    await expect(rt.run({ ...dev, text: "帮我修一下" })).rejects.toThrow(/兜圈子/);
    expect(ran.length).toBe(5);
  });

  it("token 超上限同样叫停", async () => {
    const { rt, fake, ran } = setup();
    rt.setLimits({ maxTurnTokens: 1 });
    fake.queue.push(chain(3, "先停在这"));
    const r = await rt.run({ ...dev, text: "帮我修一下" });
    expect(r.text).toBe("先停在这");
    expect(ran.length).toBe(0);
  });

  it("同一工具同样参数第三次直接拒绝", async () => {
    const { rt, fake, ran } = setup();
    fake.queue.push(chain(3, "换个思路"));
    fake.queue.push(chain(3, "换个思路", true));
    await rt.run({ ...dev, text: "a" });
    expect(ran).toEqual([1, 2, 3]);
    ran.length = 0;
    const r = await rt.run({ ...dev, text: "b" });
    expect(r.text).toBe("换个思路");
    expect(ran).toEqual([0, 0]);
  });
});

describe("token 上限可关", () => {
  it("填 0 = 不限", async () => {
    const { rt, fake, ran } = setup();
    rt.setLimits({ maxTurnTokens: 0 });
    fake.queue.push(chain(3, "做完了"));
    const r = await rt.run({ ...dev, text: "帮我修一下" });
    expect(r.text).toBe("做完了");
    expect(ran).toEqual([1, 2, 3]);
  });
});

describe("单轮 token 按新增的算（2026-11-24，主人「飞书里复杂任务一直做不完，让它继续，它读了进度就停了」）", async () => {
  const { TurnGuard, DEFAULT_MAX_TURN_TOKENS } = await import("../src/agent/turnguard.ts");
  it("主会话上下文很大：每次重发的那 10 万不算，30 次调用、每次多 3k 远到不了上限（以前按累加 300 多万早叫停了）", () => {
    const g = new TurnGuard(80, DEFAULT_MAX_TURN_TOKENS, "main main:main");
    for (let i = 0; i < 30; i++) g.afterModel({ input: 2000, cacheRead: 100_000 + i * 3000, output: 500 }, true);
    expect(g.reason).toBe("");
    expect(g.tokens).toBeLessThan(250_000);
    expect(g.billed).toBeGreaterThan(3_000_000);
  });
  it("一轮里真塞进大量新内容（大工具结果 / 长输出）照样叫停；截短后上下文变小不算负的", () => {
    const g = new TurnGuard(80, 100_000, "main main:main");
    g.afterModel({ input: 10_000, output: 100 }, true);
    g.afterModel({ input: 5_000, output: 100 }, true);            // 截短了
    expect(g.reason).toBe("");
    g.afterModel({ input: 120_000, output: 100 }, true);
    expect(g.reason).toMatch(/本轮新增内容已有 \d+k token/);
  });
  it("快到工具调用上限：在那次工具结果后面提醒先记进度（一轮一次）", async () => {
    const g = new TurnGuard(10, Infinity, "main main:main");
    const t: any = g.wrap({ name: "x", label: "x", description: "", parameters: {} as any, execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }) } as any);
    const outs = [];
    for (let i = 0; i < 10; i++) outs.push(await t.execute(String(i), { i }));
    const warned = outs.filter((o: any) => o.content.some((c: any) => /额度快用完了/.test(c.text)));
    expect(warned).toHaveLength(1);
    expect(outs.indexOf(warned[0])).toBe(7);                      // 第 8 次（80%）
    const halted: any = await t.execute("11", { i: 11 });
    expect(halted.content[0].text).toContain("这一轮到了单轮上限");
  });
});
