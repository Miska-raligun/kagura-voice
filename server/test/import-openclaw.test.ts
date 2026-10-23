import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { tmpdir } from "./helpers.ts";
import { AgentRegistry } from "../src/agent/registry.ts";
import { DatabaseSync } from "node:sqlite";
import { Scheduler } from "../src/agent/scheduler.ts";
import { Runtime } from "../src/agent/runtime.ts";
import { ModelRegistry } from "../src/agent/models.ts";
import { importOpenClaw, readOcJobs, describeImport, findOpenClawDirs, parseJson5ish, parseWslList, resolveOcPath } from "../src/agent/import-openclaw.ts";

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

describe("从 OpenClaw 导入：定时任务", () => {
  const sched = (reg: AgentRegistry) => {
    const rt = new Runtime(reg, new ModelRegistry({ providers: [], default: "", cheap: "" }), { maxConcurrency: 1, timeoutSecs: 5 });
    return new Scheduler(path.join(tmpdir("sch"), "s.sqlite"), rt, reg, { deliver: async () => "", busy: () => false });
  };

  it("新版：读 state/openclaw.sqlite 的 cron_jobs 表", () => {
    const reg = kaguraWithMainOnly();
    const { oc, ws } = openclawHome(JSON.stringify({ agents: { list: [{ id: "main", default: true }, { id: "mio" }] } }));
    ws("workspace", {}); ws("workspace-mio", {});
    fs.mkdirSync(path.join(oc, "state"));
    const db = new DatabaseSync(path.join(oc, "state", "openclaw.sqlite"));
    db.exec(`CREATE TABLE cron_jobs (store_key TEXT, job_id TEXT, name TEXT, enabled INTEGER, agent_id TEXT, payload_kind TEXT, job_json TEXT, state_json TEXT, sort_order INTEGER)`);
    const ins = db.prepare("INSERT INTO cron_jobs VALUES (?,?,?,?,?,?,?,?,?)");
    ins.run("/x/cron/jobs.json", "7f3a-morning", "早报", 1, "main", "agentTurn",
      JSON.stringify({ name: "早报", schedule: { kind: "cron", expr: "0 8 * * *", tz: "Asia/Shanghai" }, sessionTarget: "isolated", payload: { kind: "agentTurn", message: "讲讲今天的新闻" } }), "{}", 0);
    ins.run("/x/cron/jobs.json", "water-1", "喝水", 0, "mio", "systemEvent",
      JSON.stringify({ schedule: { kind: "every", everyMs: 7200000 }, sessionTarget: "main", payload: { kind: "systemEvent", text: "提醒喝水" } }), "{}", 1);
    db.exec("PRAGMA journal_mode=WAL");
    db.close();
    const s = sched(reg);
    const rep = importOpenClaw(oc, reg, s);
    expect(rep.jobs.imported.map((j) => [j.name, j.agent])).toEqual([["早报", "main"], ["喝水", "mio"]]);
    expect(s.get(rep.jobs.imported[0].id)).toMatchObject({ enabled: false, schedule: { kind: "cron", expr: "0 8 * * *" }, message: "讲讲今天的新闻" });
    expect(s.get(rep.jobs.imported[1].id)).toMatchObject({ kind: "systemEvent", schedule: { kind: "every", every_secs: 7200 } });
    expect(describeImport(rep).join("\n")).toContain("openclaw.sqlite（2 条）");
  });

  it("旧版 jobs.json、cron.store 指定的位置、openclaw.json 里的 cron.jobs 都读，按 id 去重", () => {
    const { oc } = openclawHome(JSON.stringify({ cron: { store: "~/.openclaw/my-cron.json", jobs: [{ id: "c1", name: "配置里的", schedule: { kind: "at", at: "2030-01-01T08:00:00Z" }, payload: { kind: "agentTurn", message: "x" } }] } }));
    fs.writeFileSync(path.join(oc, "my-cron.json"), JSON.stringify({ version: 1, jobs: [{ id: "a", name: "A", schedule: { kind: "cron", expr: "0 9 * * *" }, payload: { kind: "agentTurn", message: "a" } }] }));
    fs.mkdirSync(path.join(oc, "cron"));
    fs.writeFileSync(path.join(oc, "cron", "jobs.json"), JSON.stringify({ jobs: [{ id: "a", name: "A 重复" }, { id: "b", name: "B", schedule: { kind: "every", everyMs: 60000 }, payload: { kind: "systemEvent", text: "b" } }] }));
    const r = readOcJobs(oc);
    expect(r.jobs.map((j) => j.name)).toEqual(["A", "B", "配置里的"]);
  });

  it("一条都没有：报告里列出查过的位置", () => {
    const reg = kaguraWithMainOnly();
    const { oc } = openclawHome(null);
    const text = describeImport(importOpenClaw(oc, reg, sched(reg))).join("\n");
    expect(text).toContain("没找到定时任务");
    expect(text).toContain(path.join(oc, "state", "openclaw.sqlite"));
  });
});
