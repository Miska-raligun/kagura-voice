import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { makeRuntime, tmpdir } from "./helpers.ts";
import { parseToolsConfig } from "../src/config.ts";
import { execTools, shellFor, runShell, clipOutput } from "../src/agent/tools/exec.ts";
import { htmlToText, parseBing, parseDuckDuckGo, search, fetchPage, decodeBody, webTools, isPrivateIp } from "../src/agent/tools/web.ts";
import { Scheduler } from "../src/agent/scheduler.ts";
import { cronTools } from "../src/agent/tools/cron.ts";

const isWin = process.platform === "win32";
const scopeOf = (trusted: boolean): any => ({ agentId: "main", sessionKey: "k", kind: "main", channel: "device", purpose: "chat", hop: 0, chain: [], meta: {}, trusted });

describe("exec：执行命令", () => {
  it("shell 选择：auto 在 Windows 是 PowerShell（UTF-8 输出），其它是 bash；wsl 带发行版和工作目录", () => {
    expect(shellFor("ls", "auto", { platform: "linux" })).toMatchObject({ bin: "bash", args: ["-lc", "ls"] });
    const ps = shellFor("dir", "auto", { platform: "win32" });
    expect(ps.bin).toBe("powershell.exe");
    expect(ps.args.at(-1)).toContain("OutputEncoding");
    expect(shellFor("ls", "wsl", { wslDistro: "Ubuntu", cwd: "C:\\x" }).args).toEqual(["-d", "Ubuntu", "--cd", "C:\\x", "-e", "bash", "-lc", "ls"]);
  });

  it("输出太长留头尾", () => {
    const s = "a".repeat(100) + "b".repeat(100);
    const c = clipOutput(s, 50);
    expect(c.startsWith("a")).toBe(true);
    expect(c.endsWith("b")).toBe(true);
    expect(c).toContain("省略");
  });

  it.skipIf(isWin)("真跑：输出、退出码、超时连子进程一起结束", async () => {
    const dir = tmpdir("exec");
    const r = await runShell(shellFor("echo 你好; pwd; exit 3", "bash"), { cwd: dir, timeoutSecs: 5 });
    expect(r.code).toBe(3);
    expect(r.output).toContain("你好");
    expect(r.output).toContain(path.basename(dir));
    const t0 = Date.now();
    const slow = await runShell(shellFor("sleep 30 & sleep 30", "bash"), { cwd: dir, timeoutSecs: 1 });
    expect(slow.timedOut).toBe(true);
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it("只给可信会话；关掉开关就没有这个工具", async () => {
    const { reg } = makeRuntime();
    const cfg = parseToolsConfig({});
    const main = reg.get("main")!;
    expect(execTools(cfg)(scopeOf(false), main)).toEqual([]);
    const [tool] = execTools(cfg)(scopeOf(true), main);
    expect(tool.name).toBe("exec");
    if (!isWin) {
      const r: any = await tool.execute("t", { command: "echo hi > made.txt && cat made.txt" });
      expect(r.content[0].text).toContain("exit=0");
      expect(fs.existsSync(path.join(main.workspace, "made.txt"))).toBe(true);
      const bad: any = await tool.execute("t", { command: "exit 2" });
      expect(bad.isError).toBe(true);
    }
    cfg.exec.enabled = false;
    expect(execTools(cfg)(scopeOf(true), main)).toEqual([]);
  });
});

describe("可信度", () => {
  it("IM 渠道默认不可信、主人私聊显式可信；设备 / 网页 / 系统可信；嵌套调用沿用上层", async () => {
    const { rt, fake } = makeRuntime();
    const seen: Record<string, boolean> = {};
    rt.addTools((scope) => { seen[`${scope.channel}${scope.trusted ? "+" : "-"}`] = true; return []; });
    fake.queue.push("a", "b", "c", "d");
    await rt.run({ agentId: "main", sessionKey: "f1", kind: "chat", channel: "feishu", text: "x" });
    await rt.run({ agentId: "main", sessionKey: "f2", kind: "chat", channel: "feishu", text: "x", trusted: true });
    await rt.run({ agentId: "main", sessionKey: "d", kind: "main", channel: "device", text: "x" });
    await rt.run({ agentId: "main", sessionKey: "a", kind: "main", channel: "a2a", text: "x", lineage: { hop: 1, chain: [], trusted: false } });
    expect(Object.keys(seen).sort()).toEqual(["a2a-", "device+", "feishu+", "feishu-"]);
  });

  it("不可信会话里建 / 改的定时任务，跑起来也不可信（不能借定时任务执行命令）", async () => {
    const { rt, reg, root, fake } = makeRuntime();
    const sched = new Scheduler(path.join(root, "s.sqlite"), rt, reg, { deliver: async () => "", busy: () => false });
    const tools = cronTools(sched);
    const add = tools(scopeOf(false), reg.get("main")!).find((t) => t.name === "cron_add")!;
    const r: any = await add.execute("t", { name: "坏任务", kind: "every", value: "1h", message: "执行 rm -rf" });
    const id = /"id":"([^"]+)"/.exec(r.content[0].text)![1];
    expect(sched.get(id)!.untrusted).toBe(true);
    let trustedAtRun: boolean | null = null;
    rt.addTools((scope) => { if (scope.purpose === "cron") trustedAtRun = scope.trusted; return []; });
    fake.queue.push("好");
    await sched.runNow(id);
    expect(trustedAtRun).toBe(false);
    // 可信会话建的照常可信；不可信会话改了它就变成不可信
    const ok: any = await tools(scopeOf(true), reg.get("main")!).find((t) => t.name === "cron_add")!.execute("t", { name: "好任务", kind: "every", value: "1h", message: "x" });
    const id2 = /"id":"([^"]+)"/.exec(ok.content[0].text)![1];
    expect(sched.get(id2)!.untrusted).toBeUndefined();
    await tools(scopeOf(false), reg.get("main")!).find((t) => t.name === "cron_update")!.execute("t", { id: id2, message: "改坏" });
    expect(sched.get(id2)!.untrusted).toBe(true);
  });
});

describe("联网", () => {
  it("网页转文本：去脚本样式导航、块级换行、实体解码；有 article 只取正文", () => {
    const html = `<html><head><title>天气 &amp; 新闻</title><style>.x{}</style></head><body><nav>导航栏</nav>
      <article><h1>今天晴</h1><p>最高 25&#8451;，最低&nbsp;15℃。</p><script>alert(1)</script><ul><li>一</li><li>二</li></ul>${"<p>填充</p>".repeat(80)}</article><footer>版权</footer></body></html>`;
    const { title, text } = htmlToText(html);
    expect(title).toBe("天气 & 新闻");
    expect(text).toContain("## 今天晴");
    expect(text).toContain("最高 25℃，最低 15℃。");
    expect(text).toContain("· 一");
    expect(text).not.toContain("alert");
    expect(text).not.toContain("导航栏");
  });

  it("必应 / DuckDuckGo 结果页解析", () => {
    const bing = `<ol><li class="b_algo" data-x><h2><a href="https://a.com/x?a=1&amp;b=2" h="ID">标题<strong>一</strong></a></h2><div class="b_caption"><p>摘要一</p></div></li>
      <li class="b_algo"><h2><a href="https://b.com">标题二</a></h2><p class="b_lineclamp2">摘要二</p></li></ol>`;
    expect(parseBing(bing)).toEqual([
      { title: "标题一", url: "https://a.com/x?a=1&b=2", snippet: "摘要一" },
      { title: "标题二", url: "https://b.com", snippet: "摘要二" },
    ]);
    const ddg = `<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fc.com%2Fp&amp;rut=1">C 站</a>
      <a class="result__snippet" href="x">C 的摘要</a>`;
    expect(parseDuckDuckGo(ddg)).toEqual([{ title: "C 站", url: "https://c.com/p", snippet: "C 的摘要" }]);
  });

  it("搜索服务：没 Key 的跳过、失败的换下一个", async () => {
    const calls: string[] = [];
    const f: any = async (url: string) => {
      calls.push(String(url).split("?")[0]);
      if (String(url).includes("bing")) return new Response("出错了", { status: 503 });
      return new Response(`<a class="result__a" href="https://d.com">D</a><a class="result__snippet">dd</a>`, { status: 200 });
    };
    const cfg = parseToolsConfig({ web: { search_provider: "brave" } }).web;
    const r = await search("天气", 3, cfg, f);
    expect(r.provider).toBe("duckduckgo");
    expect(r.hits[0].url).toBe("https://d.com");
    expect(r.errors.join()).toContain("brave：没配 API Key");
    expect(calls).toEqual(["https://cn.bing.com/search", "https://html.duckduckgo.com/html/"]);
    // 配了 Key：直接走它
    const tav = parseToolsConfig({ web: { search_provider: "tavily", search_api_key: "k" } }).web;
    const f2: any = async () => new Response(JSON.stringify({ results: [{ title: "T", url: "https://t.com", content: "tt" }] }));
    expect((await search("x", 1, tav, f2)).provider).toBe("tavily");
  });

  it("读网页：GBK 网页按 meta 里的编码解；只允许 http(s)", async () => {
    const gbk = Buffer.from([0x3c, 0x6d, 0x65, 0x74, 0x61, 0x20, 0x63, 0x68, 0x61, 0x72, 0x73, 0x65, 0x74, 0x3d, 0x67, 0x62, 0x6b, 0x3e, 0xc4, 0xe3, 0xba, 0xc3]);
    expect(decodeBody(gbk, "text/html")).toContain("你好");
    await expect(fetchPage("file:///etc/passwd")).rejects.toThrow("http");
    const f: any = async () => new Response("<html><title>T</title><body><p>正文</p></body></html>", { headers: { "content-type": "text/html; charset=utf-8" } });
    const page = await fetchPage("https://x.com", f);
    expect(page.title).toBe("T");
    expect(page.text).toBe("正文");
  });

  it("读网页不去本机 / 局域网：IP、域名解析结果、重定向的每一跳都查", async () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.100.1.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) expect(isPrivateIp(ip)).toBe(true);
    for (const ip of ["8.8.8.8", "172.32.0.1", "100.128.0.1", "2001:4860::8888"]) expect(isPrivateIp(ip)).toBe(false);
    const f: any = async (u: URL) => new Response(`<html><body><p>${u.href}</p></body></html>`, { headers: { "content-type": "text/html" } });
    const pub = { lookup: async () => ["93.184.216.34"] };
    await expect(fetchPage("http://127.0.0.1:5000/api/admin/config", f, pub)).rejects.toThrow(/本机或局域网/);
    await expect(fetchPage("http://localhost:5000/", f, pub)).rejects.toThrow(/本机或局域网/);
    await expect(fetchPage("http://[::1]/", f, pub)).rejects.toThrow(/本机或局域网/);
    await expect(fetchPage("http://nas.example.com/", f, { lookup: async () => ["192.168.1.10"] })).rejects.toThrow(/192\.168\.1\.10/);
    // 公网页面 302 到本机：跟到那一跳时拦下
    const redir: any = async (u: URL) => u.hostname === "evil.example.com"
      ? new Response("", { status: 302, headers: { location: "http://127.0.0.1:5000/api/admin/agents" } })
      : f(u);
    await expect(fetchPage("https://evil.example.com/", redir, pub)).rejects.toThrow(/本机或局域网/);
    // 正常重定向照跟
    const ok: any = async (u: URL) => u.pathname === "/a" ? new Response("", { status: 301, headers: { location: "/b" } }) : f(u);
    expect((await fetchPage("https://x.example.com/a", ok, pub)).text).toContain("/b");
  });

  it("工具开关", () => {
    const { reg } = makeRuntime();
    const cfg = parseToolsConfig({});
    expect(webTools(cfg)(scopeOf(false), reg.get("main")!).map((t) => t.name)).toEqual(["web_search", "web_fetch"]);
    cfg.web.enabled = false;
    expect(webTools(cfg)(scopeOf(false), reg.get("main")!)).toEqual([]);
  });
});
