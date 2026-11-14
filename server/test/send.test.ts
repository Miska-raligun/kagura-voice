// send_file：只在回复直接送到人眼前的可信会话里有；文件复制进工作目录 sent/；飞书发成图片 / 文件消息，失败的补一句；QQ 个人号只发图片
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { makeRuntime, tmpdir } from "./helpers.ts";
import { sendTools, SEND_MAX_BYTES, SEND_MAX_FILES } from "../src/agent/tools/send.ts";
import { guestLocked } from "../src/agent/toolpolicy.ts";
import { toolGuide } from "../src/agent/soul.ts";
import { FeishuAdapter, feishuFileType } from "../src/channels/feishu.ts";
import { ChannelStore } from "../src/channels/store.ts";
import { ChannelManager } from "../src/channels/manager.ts";
import type { ChannelAdapter, InboundMessage } from "../src/channels/types.ts";

const scopeOf = (o: any = {}): any => ({ agentId: "main", sessionKey: "main:webchat:owner", kind: "chat", channel: "webchat", purpose: "chat", hop: 0, chain: [], meta: {}, trusted: true, ...o });
const text = (r: any) => r.content[0].text as string;

describe("send_file 工具", () => {
  it("只在网页聊天 / 飞书 / QQ 个人号的可信会话里有；设备、子任务、陌生人没有；永远不给群聊", () => {
    const { reg } = makeRuntime();
    const a = reg.get("main")!;
    const has = (o: any) => sendTools()(scopeOf(o), a).map((t) => t.name);
    expect(has({})).toEqual(["send_file"]);
    expect(has({ channel: "feishu" })).toEqual(["send_file"]);
    expect(has({ channel: "onebot" })).toEqual(["send_file"]);
    for (const o of [{ trusted: false }, { channel: "device" }, { channel: "qq" }, { channel: "system" }, { kind: "sub" }]) expect(has(o)).toEqual([]);
    expect(guestLocked("send_file")).toBe(true);
    expect(toolGuide(["send_file"])).toContain("send_file");
  });

  it("复制一份进工作目录 sent/<日期>/（重名加序号），结果里带附件那一行；工作目录外的绝对路径也能发", async () => {
    const { reg } = makeRuntime();
    const a = reg.get("main")!;
    const outside = tmpdir("elsewhere");
    fs.writeFileSync(path.join(outside, "报告.pdf"), "%PDF-1.4 fake");
    fs.writeFileSync(path.join(a.workspace, "图.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const scope = scopeOf();
    const [tool] = sendTools()(scope, a);
    const r1 = await tool.execute("1", { path: path.join(outside, "报告.pdf") }) as any;
    const r2 = await tool.execute("2", { path: "图.png" }) as any;
    const r3 = await tool.execute("3", { path: path.join(outside, "报告.pdf") }) as any;
    const day = new Date().toLocaleDateString("sv-SE");
    expect(text(r1)).toBe(`已附上 报告.pdf（1KB），会跟这条回复一起发给主人。\n[文件 sent/${day}/报告.pdf]`);
    expect(text(r3)).toContain(`[文件 sent/${day}/报告-2.pdf]`);
    expect(scope.meta.files.map((f: any) => [f.name, f.image])).toEqual([["报告.pdf", false], ["图.png", true], ["报告-2.pdf", false]]);
    expect(fs.readFileSync(path.join(a.workspace, "sent", day, "报告.pdf"), "utf8")).toBe("%PDF-1.4 fake");
    // 原文件之后改了，发出去的那份不变
    fs.writeFileSync(path.join(outside, "报告.pdf"), "改过了");
    expect(fs.readFileSync(scope.meta.files[0].path, "utf8")).toBe("%PDF-1.4 fake");
    expect(r2.isError).toBeFalsy();
  });

  it("不存在、目录、空文件、太大、超过一轮的个数都说清楚；QQ 个人号只能发图片", async () => {
    const { reg } = makeRuntime();
    const a = reg.get("main")!;
    const ws = a.workspace;
    fs.mkdirSync(path.join(ws, "d"));
    fs.writeFileSync(path.join(ws, "empty.txt"), "");
    fs.writeFileSync(path.join(ws, "a.txt"), "x");
    const big = path.join(ws, "big.zip");
    fs.writeFileSync(big, ""); fs.truncateSync(big, SEND_MAX_BYTES + 1);
    const [tool] = sendTools()(scopeOf(), a);
    const t = async (p: string) => text(await tool.execute("x", { path: p }) as any);
    expect(await t("nope.txt")).toContain("没有这个文件");
    expect(await t("d")).toContain("先打包成 zip");
    expect(await t("empty.txt")).toContain("空文件");
    expect(await t("big.zip")).toContain("超过 30MB 发不了");
    const [qq] = sendTools()(scopeOf({ channel: "onebot" }), a);
    expect(text(await qq.execute("x", { path: "a.txt" }) as any)).toContain("只能发图片");
    const scope = scopeOf();
    const [lim] = sendTools()(scope, a);
    for (let i = 0; i < SEND_MAX_FILES; i++) await lim.execute("x", { path: "a.txt" });
    expect(text(await lim.execute("x", { path: "a.txt" }) as any)).toContain(`已经发了 ${SEND_MAX_FILES} 个文件`);
  });
});

describe("飞书发附件", () => {
  it("图片发成图片消息，其它上传成文件（按扩展名给类型）；失败的不影响别的、返回出来", async () => {
    const calls: any[] = [];
    let fail = "";
    const client = {
      request: async () => ({ bot: { open_id: "ou_bot" } }),
      im: {
        message: { reply: async (p: any) => calls.push(["reply", p]), create: async (p: any) => calls.push(["create", p.data.msg_type, JSON.parse(p.data.content)]) },
        image: { create: async () => ({ image_key: "img_k" }) },
        file: { create: async (p: any) => { calls.push(["upload", p.data.file_type, p.data.file_name, p.data.file.length]); return p.data.file_name === fail ? { code: 99991672, msg: "no permission" } : { file_key: `fk_${p.data.file_name}` }; } },
      },
    };
    const a = new FeishuAdapter("fs", { app_id: "cli", app_secret: "x" }, { client, ws: { start: async () => {}, close: () => {} }, dispatcher: () => ({}) });
    await a.start(() => {});
    const dir = tmpdir("fsfiles");
    const f = (name: string, data: string | Buffer) => { fs.writeFileSync(path.join(dir, name), data); return { name, path: path.join(dir, name), image: /\.png$/.test(name), size: data.length }; };
    fail = "坏的.zip";
    const failed = await a.send("oc1", "给你", { replyTo: "om1", files: [f("图.png", Buffer.from([1, 2])), f("表.xlsx", "x"), f("坏的.zip", "zz")] });
    expect(calls.slice(1)).toEqual([
      ["create", "image", { image_key: "img_k" }],
      ["upload", "xls", "表.xlsx", 1], ["create", "file", { file_key: "fk_表.xlsx" }],
      ["upload", "stream", "坏的.zip", 2],
    ]);
    expect(failed).toEqual([{ name: "坏的.zip", why: expect.stringContaining("99991672") }]);
    expect(["a.pdf", "b.DOCX", "c.csv", "d.pptx", "e.mp4"].map(feishuFileType)).toEqual(["pdf", "doc", "xls", "ppt", "stream"]);
  });
});

class FakeAdapter implements ChannelAdapter {
  readonly kind: any;
  sent: { chatId: string; text: string; opts: any }[] = [];
  failNext: { name: string; why: string }[] = [];
  constructor(readonly accountId: string, kind: string) { this.kind = kind; }
  async start() {}
  async stop() {}
  async send(chatId: string, text: string, opts: any = {}) { this.sent.push({ chatId, text, opts }); const f = opts.files?.length ? this.failNext : []; this.failNext = []; return f; }
  status() { return { state: "online" as const, detail: "", since: 0 }; }
}

describe("IM 回复带上她发的文件", () => {
  it("主人私聊：她调 send_file，文件跟着回复发出去；有没发出去的补一句", async () => {
    const env = makeRuntime();
    env.rt.addTools(sendTools());
    const store = new ChannelStore(path.join(env.root, "channels.json"));
    let ad!: FakeAdapter;
    const mgr = new ChannelManager(store, env.rt, env.reg, (acc) => (ad = new FakeAdapter(acc.id, acc.kind)));
    store.upsertAccount({ id: "fs", kind: "feishu", credentials: { app_id: "a", app_secret: "s" }, dm_policy: "allowlist" });
    store.allow("fs", "ou_1", "主人", true);
    await mgr.startAll();
    fs.writeFileSync(path.join(env.reg.get("main")!.workspace, "周报.docx"), "doc");
    env.fake.queue.push({ tool_calls: [{ name: "send_file", args: { path: "周报.docx" } }], then: "周报发你了" });
    const m: InboundMessage = { kind: "feishu", account: "fs", chatType: "dm", chatId: "oc_dm1", sender: "ou_1", text: "把周报发我", images: [], mentionedMe: false, messageId: "om1" };
    ad.failNext = [{ name: "周报.docx", why: "没有权限" }];
    await mgr.handle(m);
    expect(ad.sent[0]).toMatchObject({ text: "周报发你了", opts: { replyTo: "om1", files: [{ name: "周报.docx", image: false, size: 3 }] } });
    expect(ad.sent[1].text).toBe("（周报.docx：没有权限——没发出去）");
    // 群里陌生人：没有这个工具（调了也是 not found），不会把文件发出去
    env.fake.queue.push({ tool_calls: [{ name: "send_file", args: { path: "周报.docx" } }], then: "发不了" });
    await mgr.handle({ ...m, chatType: "group", chatId: "oc_g", sender: "ou_x", mentionedMe: true, messageId: "om2" });
    expect(ad.sent.at(-1)!.opts.files ?? []).toEqual([]);
  });
});
