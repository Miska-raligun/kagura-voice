import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "./helpers.ts";
import { zip, unzip } from "../src/util/zip.ts";
import { catalog, exportBackup, inspectBackup, stageImport, applyPending, itemOf } from "../src/backup.ts";
import { SelfUpdater, installKind, assetFor, downloadSources, netReason, windowsUpdateScript } from "../src/util/selfupdate.ts";

const w = (root: string, rel: string, c: string | Buffer) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c); };
const db = (file: string, rows: string[]) => { fs.mkdirSync(path.dirname(file), { recursive: true }); const d = new DatabaseSync(file); d.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS t(x TEXT)"); for (const r of rows) d.prepare("INSERT INTO t VALUES (?)").run(r); return d; };

function source() {
  const d = tmpdir("bk-src");
  w(d, "config.json", JSON.stringify({ port: 5000, models: { providers: [{ id: "ds", api_key: "sk-SECRET", base_url: "https://x" }], default: "ds/x" }, baidu: { asr_key: "AK", asr_secret: "AS" } }));
  w(d, "agents/main/agent.json", JSON.stringify({ name: "神乐" }));
  w(d, "agents/main/workspace/SOUL.md", "我是神乐");
  w(d, "agents/main/workspace/MEMORY.md", "主人喜欢猫");
  w(d, "agents/main/workspace/memory/2026-10-23.md", "今天聊了天");
  w(d, "agents/main/workspace/skills/s1/SKILL.md", "---\nname: s1\n---\n");
  w(d, "agents/main/workspace/uploads/a.txt", "附件");
  w(d, "agents/mio/agent.json", JSON.stringify({ name: "小澪" }));
  w(d, "agents/mio/workspace/MEMORY.md", "小澪的记忆");
  w(d, "skills/g1/SKILL.md", "---\nname: g1\n---\n");
  w(d, "channels.json", JSON.stringify({ accounts: [{ id: "fs", kind: "feishu", credentials: { app_id: "cli_x", app_secret: "SEC" } }] }));
  w(d, "mcp.json", JSON.stringify({ mcpServers: { a: { command: "x", env: { TOKEN: "T", REF: "${HOME}" } } } }));
  w(d, "packages.json", JSON.stringify([{ id: "p1", kind: "npm", source: "npm:p1", dir: "/old/p1" }, { id: "up", kind: "upload", source: "upload:u.ts", dir: "/old/up" }]));
  w(d, "packages/up/extensions/u.ts", "export default () => {}");
  w(d, "packages/p1/node_modules/huge/index.js", "x".repeat(1000));
  const s1 = db(path.join(d, "agents/main/agent.sqlite"), ["会话1", "会话2"]);
  const s2 = db(path.join(d, "system.sqlite"), ["任务"]);
  return { d, close: () => { s1.close(); s2.close(); } };
}

describe("zip 写 / 读", () => {
  it("往返一致（中文名、空文件、压缩与不压缩）", () => {
    const entries = [{ name: "a/中文.txt", data: Buffer.from("你好".repeat(100)) }, { name: "b.bin", data: crypto.randomBytes(100) }, { name: "empty", data: Buffer.alloc(0) }];
    const back = unzip(zip(entries));
    expect(back.map((e) => e.name)).toEqual(entries.map((e) => e.name));
    back.forEach((e, i) => expect(e.data.equals(entries[i].data)).toBe(true));
  });
});

describe("导出 / 导入", () => {
  it("目录列出各 agent 的各部分；文件归属判断", () => {
    const { d, close } = source();
    const ids = catalog(d).map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining(["settings", "agent:main:profile", "agent:main:memory", "agent:main:sessions", "agent:mio:memory", "skills", "channels", "jobs", "packages", "extensions"]));
    expect(itemOf("agents/main/workspace/SOUL.md")).toBe("agent:main:profile");
    expect(itemOf("agents/main/workspace/MEMORY.md")).toBe("agent:main:memory");
    expect(itemOf("agents/main/workspace/uploads/a.txt")).toBe("agent:main:files");
    close();
  });

  it("不含密钥导出 → 导入到另一台：密钥 / 端口保留本机的，数据库快照可读，原文件进备份，扩展包排队重装", () => {
    const { d, close } = source();
    const all = catalog(d).map((c) => c.id);
    const { buf, manifest } = exportBackup(d, all, { secrets: false, version: "1.0.0" });
    close();
    expect(manifest.secrets).toBe(false);
    const files = unzip(buf, { maxTotal: 1e9 }).map((e) => e.name);
    expect(files).toContain("data/agents/main/agent.sqlite");
    expect(files.some((f) => f.includes("node_modules"))).toBe(false);          // npm 包不搬 node_modules
    const cfgOut = JSON.parse(unzip(buf).find((e) => e.name === "data/config.json")!.data.toString());
    expect(cfgOut.models.providers[0].api_key).toBe("");
    expect(cfgOut.baidu.asr_secret).toBe("");
    const mcpOut = JSON.parse(unzip(buf).find((e) => e.name === "data/mcp.json")!.data.toString());
    expect(mcpOut.mcpServers.a.env).toEqual({ TOKEN: "", REF: "${HOME}" });
    expect(inspectBackup(buf).items.length).toBe(manifest.items.length);

    // 另一台：已有自己的设置和密钥、自己的 SOUL.md
    const t = tmpdir("bk-dst");
    w(t, "config.json", JSON.stringify({ port: 5080, models: { providers: [{ id: "ds", api_key: "sk-LOCAL" }] }, baidu: { asr_key: "LK", asr_secret: "LS" } }));
    w(t, "agents/main/agent.json", JSON.stringify({ name: "旧" }));
    w(t, "agents/main/workspace/SOUL.md", "旧人设");
    w(t, "channels.json", JSON.stringify({ accounts: [{ id: "fs", credentials: { app_id: "old", app_secret: "LOCALSEC" } }] }));
    const r = stageImport(t, buf, ["settings", "agent:main:profile", "agent:main:memory", "agent:main:sessions", "agent:mio:memory", "channels", "jobs", "packages"]);
    expect(r.items).toContain("agent:mio:profile");                             // 本机没有 mio：自动带上人设
    expect(fs.readFileSync(path.join(t, "agents/main/workspace/SOUL.md"), "utf8")).toBe("旧人设");   // 重启前不动
    expect(applyPending(t, () => {})).toEqual(expect.arrayContaining(["settings", "agent:mio:profile"]));
    const cfg = JSON.parse(fs.readFileSync(path.join(t, "config.json"), "utf8"));
    expect(cfg.port).toBe(5080);
    expect(cfg.models.providers[0].api_key).toBe("sk-LOCAL");
    expect(cfg.models.default).toBe("ds/x");
    expect(cfg.baidu).toEqual({ asr_key: "LK", asr_secret: "LS" });       // 百度 API Key 也算密钥
    expect(fs.readFileSync(path.join(t, "agents/main/workspace/SOUL.md"), "utf8")).toBe("我是神乐");
    expect(fs.readFileSync(path.join(t, "agents/mio/workspace/MEMORY.md"), "utf8")).toBe("小澪的记忆");
    expect(fs.existsSync(path.join(t, "agents/mio/agent.json"))).toBe(true);
    expect(fs.existsSync(path.join(t, "agents/main/workspace/uploads/a.txt"))).toBe(false);   // 没勾「其它文件」
    const conn = new DatabaseSync(path.join(t, "agents/main/agent.sqlite"));
    expect(conn.prepare("SELECT count(*) n FROM t").get()).toEqual({ n: 2 });
    conn.close();
    expect(JSON.parse(fs.readFileSync(path.join(t, "channels.json"), "utf8")).accounts[0].credentials).toEqual({ app_id: "old", app_secret: "LOCALSEC" });
    expect(JSON.parse(fs.readFileSync(path.join(t, "packages-reinstall.json"), "utf8"))).toEqual(["npm:p1"]);
    const pk = JSON.parse(fs.readFileSync(path.join(t, "packages.json"), "utf8"));
    expect(pk.map((x: any) => x.id)).toEqual(["up"]);
    expect(pk[0].dir).toBe(path.join(t, "packages", "up"));
    expect(fs.existsSync(path.join(t, "packages/up/extensions/u.ts"))).toBe(true);
    const bk = fs.readdirSync(path.join(t, "backups"));
    expect(bk.length).toBe(1);
    expect(fs.readFileSync(path.join(t, "backups", bk[0], "agents/main/workspace/SOUL.md"), "utf8")).toBe("旧人设");
    expect(applyPending(t, () => {})).toBe(null);                               // 只导一次
  });

  it("含密钥导出原样带上；不是备份包、路径越界都拒绝", () => {
    const { d, close } = source();
    const { buf } = exportBackup(d, ["settings"], { secrets: true, version: "1" });
    close();
    expect(JSON.parse(unzip(buf).find((e) => e.name === "data/config.json")!.data.toString()).models.providers[0].api_key).toBe("sk-SECRET");
    expect(() => inspectBackup(zip([{ name: "x.txt", data: Buffer.from("x") }]))).toThrow(/不是 Kagura/);
    const evil = zip([{ name: "kagura-backup.json", data: Buffer.from(JSON.stringify({ format: 1, app: "kagura", items: [{ id: "skills" }] })) }, { name: "data/skills/../../evil", data: Buffer.from("x") }]);
    expect(() => stageImport(tmpdir("bk"), evil, ["skills"])).toThrow(/不安全/);
  });
});

describe("在线更新", () => {
  it("判断安装方式与对应的安装包", () => {
    expect(installKind({}, "C:\\Program Files\\Kagura\\kagura.exe", "win32", true)).toBe("windows");
    expect(installKind({ APPIMAGE: "/home/u/K.AppImage" }, "/tmp/.mount/usr/bin/kagura", "linux", true)).toBe("appimage");
    expect(installKind({}, "/opt/kagura/kagura", "linux", true)).toBe("deb");
    expect(installKind({}, "/usr/bin/node", "linux", false)).toBe("unsupported");
    const assets = [{ name: "Kagura-Setup-1.0.0.exe", url: "w", size: 1 }, { name: "Kagura-1.0.0-x86_64.AppImage", url: "a", size: 1 }, { name: "kagura_1.0.0_amd64.deb", url: "d", size: 1 }];
    expect(assetFor("windows", assets)!.url).toBe("w");
    expect(assetFor("deb", assets)!.url).toBe("d");
  });

  it("下载、按 SHA256SUMS 校验；不符就丢弃；deb 给出安装命令", async () => {
    const body = Buffer.from("fake deb content");
    const sha = crypto.createHash("sha256").update(body).digest("hex");
    let sums = `${sha}  kagura_1.0.0_amd64.deb\n`;
    const f = (async (url: string) => (url === "sums" ? new Response(sums) : new Response(new Uint8Array(body), { headers: { "content-length": String(body.length) } }))) as any;
    const info: any = { newer: true, latest: "1.0.0", assets: [{ name: "kagura_1.0.0_amd64.deb", url: "deb", size: body.length }, { name: "SHA256SUMS", url: "sums", size: 10 }] };
    const dir = tmpdir("upd");
    const u = new SelfUpdater(dir, f, "deb", () => { throw new Error("deb 不该自己重启"); });
    const st = await u.install(info);
    expect(st.phase).toBe("manual");
    expect(st.command).toContain(path.join(dir, "updates", "kagura_1.0.0_amd64.deb"));
    expect(fs.readFileSync(path.join(dir, "updates", "kagura_1.0.0_amd64.deb")).equals(body)).toBe(true);
    sums = `${"0".repeat(64)}  kagura_1.0.0_amd64.deb\n`;
    const bad = await new SelfUpdater(tmpdir("upd"), f, "deb").install(info);
    expect(bad).toMatchObject({ phase: "error" });
    expect(bad.message).toContain("校验失败");
    expect((await new SelfUpdater(dir, f, "unsupported").install(info)).message).toContain("不支持");
    expect((await new SelfUpdater(dir, f, "deb").install({ ...info, newer: false })).message).toContain("最新");
  });
});

describe("在线更新：下载源与断点续传", () => {
  const body = Buffer.alloc(100_000);
  for (let i = 0; i < body.length; i++) body[i] = i % 251;
  const sha = crypto.createHash("sha256").update(body).digest("hex");
  const GH = "https://github.com/o/r/releases/download/v1/kagura_1.0.0_amd64.deb";
  const info = (digest = `sha256:${sha}`): any => ({ newer: true, latest: "1.0.0", assets: [{ name: "kagura_1.0.0_amd64.deb", url: GH, size: body.length, digest }] });
  const reset = () => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) });
  /** 一个响应：从 range 起点开始给，给到 cut 字节后断开 */
  const partial = (start: number, cut = Infinity) => {
    const data = body.subarray(start, Math.min(body.length, start + cut));
    let sent = false;
    const stream = new ReadableStream({
      // 先把数据交出去，下一次读的时候再断（start 里直接 error 会把排队的数据一起丢掉）
      pull(c) { if (sent) { if (start + cut < body.length) c.error(new Error("terminated")); else c.close(); } else { sent = true; c.enqueue(new Uint8Array(data)); } },
    });
    return new Response(stream, { status: start ? 206 : 200, headers: { "content-length": String(body.length - start) } });
  };
  const startOf = (init: any) => Number(/bytes=(\d+)-/.exec(init?.headers?.range ?? "")?.[1] ?? 0);

  it("只对 github.com 的地址套镜像；报错翻成人话", () => {
    expect(downloadSources(GH, ["https://m1.com", "https://m2.com/"]).map((s) => s.url)).toEqual([GH, `https://m1.com/${GH}`, `https://m2.com/${GH}`]);
    expect(downloadSources("https://example.com/x", ["https://m1.com"])).toHaveLength(1);
    expect(netReason(reset())).toBe("连接被重置（ECONNRESET）");
    expect(netReason(Object.assign(new Error("x"), { name: "AbortError" }))).toContain("没有收到数据");
  });

  it("直连被重置 → 换镜像；镜像中途断开 → 同一个镜像续传；按 GitHub 给的 digest 校验", async () => {
    const calls: string[] = [];
    let mirrorHits = 0;
    const f = (async (url: string, init: any) => {
      calls.push(`${url.startsWith("https://m1") ? "m1" : "gh"}@${startOf(init)}`);
      if (!url.startsWith("https://m1")) throw reset();
      return partial(startOf(init), mirrorHits++ === 0 ? 40_000 : Infinity);
    }) as any;
    const dir = tmpdir("upd");
    const st = await new SelfUpdater(dir, f, "deb", undefined, { mirrors: ["https://m1.com"] }).install(info());
    expect(st.phase).toBe("manual");
    expect(fs.readFileSync(path.join(dir, "updates", "kagura_1.0.0_amd64.deb")).equals(body)).toBe(true);
    expect(calls).toEqual(["gh@0", "m1@0", "m1@40000"]);
  });

  it("镜像给的文件对不上 digest 就丢掉换下一个；全部失败时列出每个源的原因", async () => {
    const f = (async (url: string, init: any) => {
      if (url.startsWith("https://bad")) return new Response(new Uint8Array(body.length), { status: 200 });
      if (url.startsWith("https://good")) return partial(startOf(init));
      throw reset();
    }) as any;
    const dir = tmpdir("upd");
    expect((await new SelfUpdater(dir, f, "deb", undefined, { mirrors: ["https://bad.com", "https://good.com"] }).install(info())).phase).toBe("manual");
    const fail = await new SelfUpdater(tmpdir("upd"), f, "deb", undefined, { mirrors: ["https://bad.com"] }).install(info());
    expect(fail.phase).toBe("error");
    expect(fail.message).toMatch(/GitHub 直连（连接被重置（ECONNRESET））；bad\.com（校验不符）/);
    expect(fail.message).toContain("代理");
  });

  it("没有 digest 的老发布不走镜像（SHA256SUMS 从镜像拿不可信）", async () => {
    const seen: string[] = [];
    const f = (async (url: string) => { seen.push(url); throw reset(); }) as any;
    await new SelfUpdater(tmpdir("upd"), f, "deb", undefined, { mirrors: ["https://m1.com"] }).install(info(""));
    expect(seen.every((u) => !u.startsWith("https://m1"))).toBe(true);
  });

  it("直连一直慢慢给：测速太慢就换镜像，已下的部分接着续传", async () => {
    const calls: string[] = [];
    const f = (async (url: string, init: any) => {
      calls.push(`${url.startsWith("https://m1") ? "m1" : "gh"}@${startOf(init)}`);
      if (url.startsWith("https://m1")) return partial(startOf(init));
      let off = startOf(init);
      const stream = new ReadableStream({                     // 每 10ms 给 10 字节：1 KB/s
        async pull(c) {
          await new Promise((r) => setTimeout(r, 10));
          if (init.signal.aborted) { c.error(Object.assign(new Error("aborted"), { name: "AbortError" })); return; }
          c.enqueue(new Uint8Array(body.subarray(off, off + 10))); off += 10;
        },
      });
      return new Response(stream, { status: 200 });
    }) as any;
    const dir = tmpdir("upd");
    const st = await new SelfUpdater(dir, f, "deb", undefined, { mirrors: ["https://m1.com"], slowBps: 1_000_000, slowWindowMs: 150 }).install(info());
    expect(st.phase).toBe("manual");
    expect(fs.readFileSync(path.join(dir, "updates", "kagura_1.0.0_amd64.deb")).equals(body)).toBe(true);
    expect(calls[0]).toBe("gh@0");
    expect(calls[1]).toMatch(/^m1@[1-9]\d*$/);                // 从直连已下到的地方续传
  });

  it("连上了但一直不给数据：超时换下一个源", async () => {
    const f = (async (url: string, init: any) => {
      if (url.startsWith("https://m1")) return partial(startOf(init));
      return new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))));
    }) as any;
    const st = await new SelfUpdater(tmpdir("upd"), f, "deb", undefined, { mirrors: ["https://m1.com"], stallMs: 50 }).install(info());
    expect(st.phase).toBe("manual");
  });
});

describe("在线更新：Windows 安装脚本", () => {
  it("选了「否」只记一笔不动服务端；装失败且服务端还活着不动；装完关掉旧托盘图标再拉起", () => {
    const ps = windowsUpdateScript("C:\\Users\\o'k\\Kagura-Setup-1.exe", "C:\\Program Files\\Kagura\\kagura-tray.exe", "C:\\d\\update.log");
    expect(ps).toContain("'C:\\Users\\o''k\\Kagura-Setup-1.exe'");                  // 单引号转义
    expect(ps).toMatch(/catch \{ Log \('uac-declined/);
    expect(ps.indexOf("installer exit")).toBeLessThan(ps.indexOf("server still running"));
    expect(ps.indexOf("tray.ps1")).toBeLessThan(ps.indexOf("Start-Process -FilePath 'C:\\Program Files"));
    expect(ps).toContain("'--tray','--no-browser'");
    expect(ps).not.toMatch(/-Wait/);                                                    // 用 WaitForExit，先取句柄才读得到退出码
    expect(ps).toContain("$null = $p.Handle");
  });
});
