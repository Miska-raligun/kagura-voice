import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { tmpdir } from "./helpers.ts";
import { AgentRegistry } from "../src/agent/registry.ts";
import { importOpenClaw, describeImport, findOpenClawDirs, parseJson5ish, parseWslList, resolveOcPath } from "../src/agent/import-openclaw.ts";

/** Kagura 这边只有默认的 main（没跑过 migrate 的典型情况） */
function kaguraWithMainOnly() {
  const root = tmpdir("kg");
  fs.mkdirSync(path.join(root, "agents"));
  const reg = new AgentRegistry(path.join(root, "agents"));
  reg.load([{ id: "", name: "神乐", agent: "main", per: 111 }]);
  return reg;
}

function openclawHome(conf: string | null) {
  const home = tmpdir("home");
  const oc = path.join(home, ".openclaw");
  fs.mkdirSync(oc);
  if (conf !== null) fs.writeFileSync(path.join(oc, "openclaw.json"), conf);
  const ws = (name: string, files: Record<string, string>) => {
    const d = path.join(oc, name);
    fs.mkdirSync(path.join(d, "memory"), { recursive: true });
    for (const [f, t] of Object.entries(files)) fs.writeFileSync(path.join(d, f), t);
  };
  return { home, oc, ws };
}

describe("从 OpenClaw 导入：发现全部 agent", () => {
  it("openclaw.json（JSON5，带注释）里登记的第二个 agent：Kagura 里没有就新建，人设、记忆、任务都跟过去", () => {
    const reg = kaguraWithMainOnly();
    const { oc, ws } = openclawHome(`{
      // OpenClaw 配置
      agents: {
        defaults: { workspace: "~/.openclaw/workspace" },
        list: [
          { id: "main", default: true, name: "神乐" },
          { id: "mio", name: "小澪", workspace: "~/.openclaw/workspace-mio", },
        ],
      },
    }`);
    ws("workspace", { "SOUL.md": "神乐的灵魂" });
    ws("workspace-mio", { "SOUL.md": "小澪的灵魂", "memory/2026-10-01.md": "小澪的笔记" });
    fs.mkdirSync(path.join(oc, "cron"));
    fs.writeFileSync(path.join(oc, "cron", "jobs.json"), JSON.stringify({ jobs: [
      { id: "w", name: "喝水", agentId: "mio", schedule: { kind: "every", everyMs: 3600000 }, payload: { kind: "agentTurn", message: "提醒喝水" } },
    ] }));
    const rep = importOpenClaw(oc, reg, null);
    expect(rep.agents.map((a) => [a.id, a.into, a.created])).toEqual([["main", "main", false], ["mio", "mio", true]]);
    expect(fs.readFileSync(path.join(reg.get("main")!.workspace, "SOUL.md"), "utf8")).toBe("神乐的灵魂");
    expect(fs.readFileSync(path.join(reg.get("mio")!.workspace, "SOUL.md"), "utf8")).toBe("小澪的灵魂");
    expect(fs.existsSync(path.join(reg.get("mio")!.workspace, "memory", "2026-10-01.md"))).toBe(true);
    expect(reg.get("mio")!.name).toBe("小澪");
    expect(reg.get("main")!.a2a.allow).toContain("mio");
    expect(reg.get("mio")!.a2a.allow).toContain("main");
    expect(describeImport(rep).join("\n")).toContain("新建了 agent mio");
  });

  it("没有配置文件也能从目录名 workspace-<id> 发现；任务指到新 agent", () => {
    const reg = kaguraWithMainOnly();
    const { oc, ws } = openclawHome(null);
    ws("workspace", { "IDENTITY.md": "我是神乐" });
    ws("workspace-work", { "SOUL.md": "工作助手" });
    const rep = importOpenClaw(oc, reg, null);
    expect(rep.agents.map((a) => a.into).sort()).toEqual(["main", "work"]);
    expect(fs.readFileSync(path.join(reg.get("work")!.workspace, "SOUL.md"), "utf8")).toBe("工作助手");
  });

  it("OpenClaw 默认 agent 叫别的名字：导进 Kagura 的默认 agent，不另建", () => {
    const reg = kaguraWithMainOnly();
    const { oc, ws } = openclawHome(JSON.stringify({ agents: { list: [{ id: "kagura", default: true, workspace: "~/.openclaw/ws-k" }] } }));
    ws("ws-k", { "SOUL.md": "默认的灵魂" });
    const rep = importOpenClaw(oc, reg, null);
    expect(rep.agents[0]).toMatchObject({ id: "kagura", into: "main", created: false });
    expect(reg.list().map((a) => a.id)).toEqual(["main"]);
    expect(fs.readFileSync(path.join(reg.get("main")!.workspace, "SOUL.md"), "utf8")).toBe("默认的灵魂");
  });

  it("一个 workspace 都找不到：报告里列出查过的位置", () => {
    const reg = kaguraWithMainOnly();
    const { oc } = openclawHome(null);
    const text = describeImport(importOpenClaw(oc, reg, null)).join("\n");
    expect(text).toContain("一个 workspace 都没找到");
    expect(text).toContain(path.join(oc, "workspace"));
  });
});

describe("路径与平台", () => {
  it("workspace 路径换算：~、相对、WSL UNC 下的 Linux 绝对路径", () => {
    expect(resolveOcPath("~/.openclaw/ws", "/home/a/.openclaw")).toBe(path.join("/home/a", ".openclaw", "ws"));
    expect(resolveOcPath("ws-x", "/home/a/.openclaw")).toBe(path.join("/home/a/.openclaw", "ws-x"));
    expect(resolveOcPath("/home/a/proj", "\\\\wsl.localhost\\Ubuntu\\home\\a\\.openclaw")).toBe("\\\\wsl.localhost\\Ubuntu\\home\\a\\proj");
  });

  it("JSON5 宽松解析", () => {
    expect(parseJson5ish(`{ a: 1, // 注释\n b: "http://x", /* 块 */ c: [1,2,], }`)).toEqual({ a: 1, b: "http://x", c: [1, 2] });
    expect(parseJson5ish("not json")).toBeNull();
  });

  it("wsl -l -q 的 UTF-16 输出", () => {
    expect(parseWslList(Buffer.from("﻿Ubuntu\r\ndocker-desktop\r\n\r\n", "utf16le"))).toEqual(["Ubuntu", "docker-desktop"]);
  });

  it("找 OpenClaw 目录：配置的优先，再找家目录", () => {
    const { home, oc } = openclawHome(null);
    expect(findOpenClawDirs("", home, () => [])).toEqual([oc]);
    expect(findOpenClawDirs("/不存在", "/也不存在", () => [])).toEqual([]);
  });
});
