// 单测公用：临时数据目录 + agent 注册表 + 假模型
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentRegistry } from "../src/agent/registry.ts";
import { ModelRegistry, type FakeStep } from "../src/agent/models.ts";
import { Runtime } from "../src/agent/runtime.ts";

export class FakeCtl {
  queue: FakeStep[] = [];
  calls: any[] = [];
  nextStep(): FakeStep { return this.queue.length ? this.queue.shift()! : "好的。"; }
  logCall(e: any) { this.calls.push(e); }
}

export function tmpdir(tag = "kagura") {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${tag}-`));
}

export function makeRuntime(opts: { roles?: any[]; cheap?: string } = {}) {
  const root = tmpdir();
  const agentsDir = path.join(root, "agents");
  fs.mkdirSync(agentsDir);
  const reg = new AgentRegistry(agentsDir);
  reg.load(opts.roles ?? [{ id: "", name: "神乐", agent: "main", per: 111 }, { id: "mio", name: "小澪", agent: "mio", per: 4 }]);
  const models = new ModelRegistry({ providers: [], default: "fake/fake", cheap: opts.cheap ?? "" });
  const fake = new FakeCtl();
  models.enableFake(fake);
  const rt = new Runtime(reg, models, { maxConcurrency: 4, timeoutSecs: 10 });
  rt.backgroundCompact = false;            // 后台预压缩会抢假模型的回复队列；需要的测试自己打开
  return { root, reg, models, fake, rt };
}
