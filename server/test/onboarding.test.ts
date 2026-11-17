// 新用户：默认 agent 不叫死名字、人设不假定有 CoreS3、改名时没动过的模板跟着换、heartbeat 默认自动挑设备
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { AgentRegistry, DEFAULT_AGENT_NAME, templates } from "../src/agent/registry.ts";
import { CHANNEL_HINTS } from "../src/agent/soul.ts";
import { tmpdir } from "./helpers.ts";

describe("首次启动", () => {
  it("没有角色表：默认 agent 叫占位名字，人设模板不提 CoreS3，heartbeat 默认投递 auto", () => {
    const reg = new AgentRegistry(tmpdir("agents"));
    reg.load(null);
    const a = reg.get("main")!;
    expect(a.name).toBe(DEFAULT_AGENT_NAME);
    expect(a.heartbeat.delivery).toBe("auto");
    const soul = fs.readFileSync(path.join(a.workspace, "SOUL.md"), "utf8") + fs.readFileSync(path.join(a.workspace, "IDENTITY.md"), "utf8");
    expect(soul).not.toMatch(/CoreS3|神乐/);
    expect(CHANNEL_HINTS.device).not.toContain("CoreS3");
  });

  it("改名：没动过的 SOUL / IDENTITY 跟着换成新名字；主人改过的不碰", () => {
    const reg = new AgentRegistry(tmpdir("agents"));
    reg.load(null);
    const ws = reg.get("main")!.workspace;
    reg.update("main", { name: "小澪" });
    expect(fs.readFileSync(path.join(ws, "SOUL.md"), "utf8")).toBe(templates("小澪")["SOUL.md"]);
    expect(fs.readFileSync(path.join(ws, "IDENTITY.md"), "utf8")).toContain("名字：小澪");
    fs.writeFileSync(path.join(ws, "SOUL.md"), "我是小澪，自己写的设定");
    reg.update("main", { name: "阿澪" });
    expect(fs.readFileSync(path.join(ws, "SOUL.md"), "utf8")).toBe("我是小澪，自己写的设定");
    expect(fs.readFileSync(path.join(ws, "IDENTITY.md"), "utf8")).toContain("名字：阿澪");
  });
});
