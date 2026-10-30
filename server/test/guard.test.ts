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
    expect(tr.content[0].text).toContain("不要再调用任何工具");
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
