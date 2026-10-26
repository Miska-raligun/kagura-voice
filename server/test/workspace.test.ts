// 自定义 agent 工作目录：设置、搬家、冲突检查、用不了时退回默认、导出导入
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "./helpers.ts";
import { AgentRegistry } from "../src/agent/registry.ts";
import { exportBackup, stageImport, applyPending } from "../src/backup.ts";

function reg() {
  const data = tmpdir("ws-data");
  const agents = path.join(data, "agents");
  fs.mkdirSync(agents, { recursive: true });
  const r = new AgentRegistry(agents);
  r.load(null);
  return { data, agents, r };
}

describe("自定义工作目录", () => {
  it("改到别处：旧目录的人设和记忆整个复制过去，旧的留着", () => {
    const { r } = reg();
    const old = r.get("main")!.workspace;
    fs.writeFileSync(path.join(old, "memory", "2026-10-26.md"), "今天的笔记");
    const target = path.join(tmpdir("ws-target"), "kagura-main");
    const a = r.update("main", { workspace_dir: target });
    expect(a.workspace).toBe(target);
    expect(fs.readFileSync(path.join(target, "memory", "2026-10-26.md"), "utf8")).toBe("今天的笔记");
    expect(fs.existsSync(path.join(target, "SOUL.md"))).toBe(true);
    expect(fs.existsSync(path.join(old, "SOUL.md"))).toBe(true);
    // 重启后照样用新目录
    const r2 = new AgentRegistry(path.dirname(r.get("main")!.dir));
    r2.load(null);
    expect(r2.get("main")!.workspace).toBe(target);
    expect(r2.readFile("main", "SOUL.md")).toContain("神乐");
  });

  it("指向已有的工作区：里面的人设不覆盖，只补缺的", () => {
    const { r } = reg();
    const existing = tmpdir("ws-oc");
    fs.writeFileSync(path.join(existing, "SOUL.md"), "我是原来那个");
    r.update("main", { workspace_dir: existing });
    expect(fs.readFileSync(path.join(existing, "SOUL.md"), "utf8")).toBe("我是原来那个");
    expect(fs.existsSync(path.join(existing, "IDENTITY.md"))).toBe(true);
    // 新建时直接指过去也一样
    const ex2 = tmpdir("ws-oc2");
    fs.writeFileSync(path.join(ex2, "SOUL.md"), "第二个");
    const b = r.create("mio", { workspace_dir: ex2 });
    expect(b.workspace).toBe(ex2);
    expect(fs.readFileSync(path.join(ex2, "SOUL.md"), "utf8")).toBe("第二个");
  });

  it("拒绝：相对路径、包住数据目录、和别的 agent 重叠", () => {
    const { data, r } = reg();
    expect(() => r.update("main", { workspace_dir: "ws/main" })).toThrow(/完整路径/);
    expect(() => r.update("main", { workspace_dir: data })).toThrow(/数据目录/);
    const shared = tmpdir("ws-shared");
    r.update("main", { workspace_dir: shared });
    expect(() => r.create("mio", { workspace_dir: shared })).toThrow(/重叠/);
    expect(() => r.create("mio", { workspace_dir: path.join(shared, "sub") })).toThrow(/重叠/);
    expect(r.get("mio")).toBeUndefined();
  });

  it("目录用不了（盘没插）：退回默认目录并标出原因，agent 照常加载", () => {
    const { agents, r } = reg();
    const blocker = path.join(tmpdir("ws-file"), "not-a-dir");
    fs.writeFileSync(blocker, "x");                // 是个文件，mkdir 必失败
    const j = path.join(agents, "main", "agent.json");
    fs.writeFileSync(j, JSON.stringify({ ...JSON.parse(fs.readFileSync(j, "utf8")), workspace_dir: path.join(blocker, "ws") }));
    const r2 = new AgentRegistry(agents);
    r2.load(null);
    const a = r2.get("main")!;
    expect(a.workspace).toBe(path.join(agents, "main", "workspace"));
    expect(a.workspace_error).toMatch(/用不了/);
    void r;
  });

  it("导出按默认布局记；导到别的电脑用默认位置，导回本机保留本机的目录", () => {
    const { data, r } = reg();
    const target = tmpdir("ws-exp");
    r.update("main", { workspace_dir: target });
    fs.writeFileSync(path.join(target, "MEMORY.md"), "主人喜欢猫");
    fs.writeFileSync(path.join(target, "memory", "d.md"), "日记");
    const { buf } = exportBackup(data, ["agent:main:profile", "agent:main:memory"], { secrets: false, version: "1" });
    // 别的电脑
    const other = tmpdir("ws-other");
    stageImport(other, buf, ["agent:main:profile", "agent:main:memory"]);
    applyPending(other, () => {});
    expect(JSON.parse(fs.readFileSync(path.join(other, "agents/main/agent.json"), "utf8")).workspace_dir).toBeUndefined();
    expect(fs.readFileSync(path.join(other, "agents/main/workspace/MEMORY.md"), "utf8")).toBe("主人喜欢猫");
    // 本机导回：写进自定义目录
    fs.writeFileSync(path.join(target, "MEMORY.md"), "改过了");
    stageImport(data, buf, ["agent:main:profile", "agent:main:memory"]);
    applyPending(data, () => {});
    expect(JSON.parse(fs.readFileSync(path.join(data, "agents/main/agent.json"), "utf8")).workspace_dir).toBe(target);
    expect(fs.readFileSync(path.join(target, "MEMORY.md"), "utf8")).toBe("主人喜欢猫");
    expect(fs.readFileSync(path.join(target, "memory", "d.md"), "utf8")).toBe("日记");
    expect(fs.existsSync(path.join(data, "agents/main/workspace/memory/d.md"))).toBe(false);
  });
});
