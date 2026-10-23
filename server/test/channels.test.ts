// M7：IM 渠道。QQ / OneBot 对本地假服务端（真 HTTP + WebSocket）跑；飞书注入假 SDK；路由层用假适配器。
import http from "node:http";
import path from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { WebSocketServer } from "ws";
import { makeRuntime } from "./helpers.ts";
import { QQAdapter } from "../src/channels/qq.ts";
import { OneBotAdapter, parseOneBotMessage } from "../src/channels/onebot.ts";
import { FeishuAdapter, parseFeishuContent } from "../src/channels/feishu.ts";
import { ChannelStore } from "../src/channels/store.ts";
import { ChannelManager } from "../src/channels/manager.ts";
import type { ChannelAdapter, InboundMessage } from "../src/channels/types.ts";

const waitFor = async (cond: () => any, ms = 3000) => {
  const t = Date.now();
  while (!cond()) { if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 10)); }
};
const cleanups: (() => any)[] = [];
afterEach(async () => { for (const f of cleanups.splice(0).reverse()) await f(); });   // 后进先出：先停客户端再关服务端

// ── QQ 官方机器人 ──
function fakeQQ() {
  const sent: any[] = [];
  const frames: any[] = [];
  const conns: any[] = [];
  let tokenCalls = 0;
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/app/getAppAccessToken") {
        tokenCalls++;
        const j = JSON.parse(body);
        if (j.clientSecret !== "s3") { res.statusCode = 401; return res.end(JSON.stringify({ message: "bad secret" })); }
        return res.end(JSON.stringify({ access_token: "tok1", expires_in: "7200" }));
      }
      if (req.headers.authorization !== "QQBot tok1") { res.statusCode = 401; return res.end("{}"); }
      if (req.url === "/gateway") return res.end(JSON.stringify({ url: `ws://127.0.0.1:${(srv.address() as any).port}/ws` }));
      if (req.method === "POST" && req.url!.startsWith("/v2/")) { sent.push({ url: req.url, body: JSON.parse(body) }); return res.end(JSON.stringify({ id: "m" })); }
      res.statusCode = 404; res.end("{}");
    });
  });
  const wss = new WebSocketServer({ server: srv, path: "/ws" });
  wss.on("connection", (ws) => {
    conns.push(ws);
    ws.on("message", (raw) => {
      const f = JSON.parse(String(raw));
      frames.push(f);
      if (f.op === 2) ws.send(JSON.stringify({ op: 0, s: 1, t: "READY", d: { session_id: "sess1", user: { id: "bot1", username: "神乐" } } }));
      if (f.op === 6) ws.send(JSON.stringify({ op: 0, s: f.d.seq + 1, t: "RESUMED", d: {} }));
    });
    ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 50 } }));
  });
  return new Promise<any>((r) => srv.listen(0, "127.0.0.1", () => {
    const base = `http://127.0.0.1:${(srv.address() as any).port}`;
    cleanups.push(() => new Promise((ok) => { wss.close(); srv.close(() => ok(null)); for (const c of conns) c.terminate(); }));
    r({ base, sent, frames, conns, tokenCalls: () => tokenCalls, dispatch: (t: string, d: any, s = 2) => conns.at(-1).send(JSON.stringify({ op: 0, s, t, d })) });
  }));
}

describe("QQ 官方机器人", () => {
  it("鉴权 → gateway → Identify → READY → 心跳；收私聊/群 @；被动回复带 msg_id；断线后 Resume", async () => {
    const q = await fakeQQ();
    const a = new QQAdapter("qq1", { app_id: "1001", secret: "s3", token_url: `${q.base}/app/getAppAccessToken`, api_base: q.base });
    const got: InboundMessage[] = [];
    await a.start((m) => got.push(m));
    cleanups.push(() => a.stop());
    await waitFor(() => a.status().state === "online");
    const ident = q.frames.find((f: any) => f.op === 2);
    expect(ident.d).toMatchObject({ token: "QQBot tok1", intents: 1 << 25 });
    await waitFor(() => q.frames.some((f: any) => f.op === 1));          // 心跳
    q.dispatch("C2C_MESSAGE_CREATE", { id: "msg1", author: { user_openid: "U1" }, content: " 你好 ", attachments: [] }, 2);
    q.dispatch("GROUP_AT_MESSAGE_CREATE", { id: "msg2", author: { member_openid: "M1" }, group_openid: "G1", content: " 大家好" }, 3);
    await waitFor(() => got.length === 2);
    expect(got[0]).toMatchObject({ chatType: "dm", chatId: "c2c:U1", sender: "U1", text: "你好", mentionedMe: false, messageId: "msg1" });
    expect(got[1]).toMatchObject({ chatType: "group", chatId: "group:G1", sender: "M1", mentionedMe: true });
    await a.send("c2c:U1", "**你好**呀", { replyTo: "msg1" });
    await a.send("group:G1", "主动推送");
    expect(q.sent[0]).toMatchObject({ url: "/v2/users/U1/messages", body: { content: "你好呀", msg_type: 0, msg_id: "msg1" } });
    expect(q.sent[1].url).toBe("/v2/groups/G1/messages");
    expect(q.sent[1].body.msg_id).toBeUndefined();
    expect(q.tokenCalls()).toBe(1);                                       // token 缓存
    // 服务端踢掉连接 → 客户端重连并 Resume（带 session_id 与最后的 seq）
    q.conns.at(-1).close();
    await waitFor(() => q.frames.some((f: any) => f.op === 6), 4000);
    expect(q.frames.find((f: any) => f.op === 6).d).toMatchObject({ session_id: "sess1", seq: 3 });
    await waitFor(() => a.status().state === "online");
  });

  it("鉴权失败：状态为 error，不抛到外面", async () => {
    const q = await fakeQQ();
    const a = new QQAdapter("qq1", { app_id: "1001", secret: "wrong", token_url: `${q.base}/app/getAppAccessToken`, api_base: q.base });
    await a.start(() => {});
    cleanups.push(() => a.stop());
    expect(a.status()).toMatchObject({ state: "error" });
    expect(a.status().detail).toContain("bad secret");
  });
});

// ── OneBot ──
describe("OneBot v11", () => {
  it("消息段与 CQ 码解析", () => {
    expect(parseOneBotMessage("[CQ:at,qq=42] 你好[CQ:image,file=a.jpg,url=http://x/a.jpg]", "42")).toEqual({ text: "你好", imageUrls: ["http://x/a.jpg"], atMe: true });
    expect(parseOneBotMessage([{ type: "at", data: { qq: "7" } }, { type: "text", data: { text: " hi" } }], "42")).toEqual({ text: "hi", imageUrls: [], atMe: false });
  });

  it("连正向 WebSocket（带 token）、收消息、调用 send_* 动作并等回执", async () => {
    const actions: any[] = [];
    let auth = "";
    const wss = new WebSocketServer({ port: 0 });
    wss.on("connection", (ws, req) => {
      auth = String(req.headers.authorization);
      ws.on("message", (raw) => { const f = JSON.parse(String(raw)); actions.push(f); ws.send(JSON.stringify({ status: "ok", retcode: 0, data: { message_id: 1 }, echo: f.echo })); });
      setTimeout(() => ws.send(JSON.stringify({ post_type: "message", message_type: "group", group_id: 88, user_id: 7, self_id: 42, message_id: 5, sender: { nickname: "小明" }, message: "[CQ:at,qq=42] 在吗" })), 20);
    });
    await new Promise((r) => wss.on("listening", r));
    cleanups.push(() => new Promise((ok) => wss.close(() => ok(null))));
    const a = new OneBotAdapter("ob", { url: `ws://127.0.0.1:${(wss.address() as any).port}`, token: "tk" });
    const got: InboundMessage[] = [];
    await a.start((m) => got.push(m));
    cleanups.push(() => a.stop());
    await waitFor(() => got.length === 1);
    expect(auth).toBe("Bearer tk");
    expect(got[0]).toMatchObject({ chatType: "group", chatId: "group:88", sender: "7", senderName: "小明", text: "在吗", mentionedMe: true });
    await a.send("group:88", "在的", { replyTo: "5" });
    expect(actions[0]).toMatchObject({ action: "send_group_msg", params: { group_id: 88, message: [{ type: "reply", data: { id: "5" } }, { type: "text", data: { text: "在的" } }] } });
  });
});

// ── 飞书 ──
describe("飞书", () => {
  it("消息内容解析：text 去 @ 占位、post 富文本、图片 key", () => {
    expect(parseFeishuContent("text", JSON.stringify({ text: "@_user_1 你好" }))).toEqual({ text: "你好", imageKeys: [] });
    expect(parseFeishuContent("post", JSON.stringify({ title: "标题", content: [[{ tag: "text", text: "看" }, { tag: "img", image_key: "k1" }]] })))
      .toEqual({ text: "标题\n看", imageKeys: ["k1"] });
    expect(parseFeishuContent("image", JSON.stringify({ image_key: "k2" }))).toEqual({ text: "", imageKeys: ["k2"] });
  });

  it("长连接事件 → 统一消息（群里只认 @ 机器人自己）；回复走 reply + md；图片先上传", async () => {
    const calls: any[] = [];
    let handler: any;
    const client = {
      request: async () => ({ bot: { open_id: "ou_bot" } }),
      im: {
        message: { reply: async (p: any) => calls.push(["reply", p]), create: async (p: any) => calls.push(["create", p]) },
        image: { create: async () => ({ image_key: "img_k" }) },
        messageResource: { get: async () => ({ getReadableStream: () => (async function* () { yield Buffer.from([0xff, 0xd8]); })() }) },
      },
    };
    const a = new FeishuAdapter("fs", { app_id: "cli", app_secret: "x" }, {
      client, ws: { start: async () => {}, close: () => {} }, dispatcher: (h) => { handler = h; return {}; },
    });
    const got: InboundMessage[] = [];
    await a.start((m) => got.push(m));
    await handler({ sender: { sender_id: { open_id: "ou_u1" }, sender_type: "user" }, message: { message_id: "om1", chat_id: "oc1", chat_type: "group", message_type: "text", content: JSON.stringify({ text: "@_user_1 看图" }), mentions: [{ key: "@_user_1", id: { open_id: "ou_other" } }] } });
    await handler({ sender: { sender_id: { open_id: "ou_u1" }, sender_type: "user" }, message: { message_id: "om2", chat_id: "oc1", chat_type: "group", message_type: "post", content: JSON.stringify({ content: [[{ tag: "img", image_key: "k" }]] }), mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" } }] } });
    await handler({ sender: { sender_type: "app" }, message: { message_id: "om3", chat_id: "oc1", chat_type: "p2p", message_type: "text", content: "{}" } });
    expect(got.map((m) => m.mentionedMe)).toEqual([false, true]);
    expect(got[1].images[0].data).toBe(Buffer.from([0xff, 0xd8]).toString("base64"));
    await a.send("oc1", "**好**", { replyTo: "om2", image: Buffer.from("jpg") });
    expect(calls[0][0]).toBe("reply");
    expect(JSON.parse(calls[0][1].data.content)).toEqual({ zh_cn: { content: [[{ tag: "md", text: "**好**" }]] } });
    expect(calls[1][1].data).toMatchObject({ receive_id: "oc1", msg_type: "image" });
  });
});

// ── 路由层 ──
class FakeAdapter implements ChannelAdapter {
  readonly kind: any;
  sent: { chatId: string; text: string; opts: any }[] = [];
  onMsg: (m: InboundMessage) => void = () => {};
  constructor(readonly accountId: string, kind: string) { this.kind = kind; }
  async start(cb: any) { this.onMsg = cb; }
  async stop() {}
  async send(chatId: string, text: string, opts: any = {}) { this.sent.push({ chatId, text, opts }); }
  status() { return { state: "online" as const, detail: "", since: 0 }; }
}

function setupMgr(acc: any = {}) {
  const env = makeRuntime();
  const store = new ChannelStore(path.join(env.root, "channels.json"));
  const ads = new Map<string, FakeAdapter>();
  const mgr = new ChannelManager(store, env.rt, env.reg, (a) => { const f = new FakeAdapter(a.id, a.kind); ads.set(a.id, f); return f; });
  store.upsertAccount({ id: "fs", kind: "feishu", credentials: { app_id: "a", app_secret: "s" }, ...acc });
  return { ...env, store, mgr, ad: () => ads.get("fs")! };
}
const msg = (o: Partial<InboundMessage> = {}): InboundMessage => ({
  kind: "feishu", account: "fs", chatType: "dm", chatId: "oc_dm1", sender: "ou_1", text: "你好", images: [], mentionedMe: false, messageId: "om1", ...o,
});

describe("渠道路由", () => {
  it("私聊默认配对制：陌生人拿配对码、内容不进 agent；批准后正常聊天", async () => {
    const { mgr, store, fake, ad } = setupMgr();
    await mgr.startAll();
    await mgr.handle(msg());
    expect(fake.calls.length).toBe(0);
    const code = store.pairings()[0].code;
    expect(ad().sent[0].text).toContain(code);
    await mgr.handle(msg({ text: "在吗" }));
    expect(ad().sent.length).toBe(1);          // 十分钟内不重复提醒
    expect(store.approve("fs", code)!.user).toBe("ou_1");
    fake.queue.push("你好呀");
    await mgr.handle(msg({ text: "现在呢" }));
    expect(ad().sent.at(-1)).toMatchObject({ chatId: "oc_dm1", text: "你好呀", opts: { replyTo: "om1" } });
    expect(fake.calls[0]).toMatchObject({ message: "现在呢", session: "main:feishu:oc_dm1", agent: "main" });
    expect(fake.calls[0].system).toContain("飞书");
  });

  it("群里默认只响应 @；all 全响应；off 不理；发言人名字带进消息", async () => {
    const { mgr, store, fake, ad } = setupMgr();
    await mgr.startAll();
    await mgr.handle(msg({ chatType: "group", chatId: "oc_g", text: "随便聊" }));
    expect(fake.calls.length).toBe(0);
    fake.queue.push("我在");
    await mgr.handle(msg({ chatType: "group", chatId: "oc_g", text: "神乐在吗", mentionedMe: true, senderName: "小明" }));
    expect(fake.calls[0].message).toBe("[小明] 神乐在吗");
    expect(ad().sent.at(-1)!.text).toBe("我在");
    store.upsertAccount({ id: "fs", group_policy: "off" });
    await mgr.handle(msg({ chatType: "group", chatId: "oc_g", text: "x", mentionedMe: true }));
    expect(fake.calls.length).toBe(1);
  });

  it("绑定：某个聊天交给指定 agent；主人私聊可并入 main 会话；/reset 重置", async () => {
    const { mgr, store, fake, rt } = setupMgr({ dm_policy: "open", owner_main: true });
    await mgr.startAll();
    store.bind({ account: "fs", chatId: "oc_g2", agent: "mio" });
    fake.queue.push("小澪在", "主人好");
    await mgr.handle(msg({ chatType: "group", chatId: "oc_g2", mentionedMe: true }));
    expect(fake.calls[0]).toMatchObject({ agent: "mio", session: "mio:feishu:oc_g2" });
    store.allow("fs", "ou_owner", "主人", true);
    await mgr.handle(msg({ sender: "ou_owner", chatId: "oc_owner" }));
    expect(fake.calls[1].session).toBe("main:main");
    await mgr.handle(msg({ sender: "ou_owner", chatId: "oc_owner", text: "/reset" }));
    expect(rt.store("main").history("main:main")).toEqual([]);
  });

  it("每日上限：超了只提醒一次；HEARTBEAT_OK/NO_REPLY 不回；出错回一句", async () => {
    const { mgr, fake, ad } = setupMgr({ dm_policy: "open", daily_limit: 2 });
    await mgr.startAll();
    fake.queue.push("一", "NO_REPLY");
    await mgr.handle(msg()); await mgr.handle(msg()); await mgr.handle(msg()); await mgr.handle(msg());
    expect(ad().sent.map((s) => s.text)).toEqual(["一", "今天的对话额度用完了，明天再聊吧。"]);
    const { mgr: m2, fake: f2, ad: ad2 } = setupMgr({ dm_policy: "open" });
    await m2.startAll();
    f2.queue.push({ error: "boom" });
    await m2.handle(msg());
    expect(ad2().sent[0].text).toContain("出错了");
  });

  it("主动投递：<渠道>:<账号>:<聊天> 与 <渠道>:<聊天> 两种写法", async () => {
    const { mgr, ad } = setupMgr();
    await mgr.startAll();
    expect(await mgr.deliver("feishu:fs:oc_x", "早报")).toBe(true);
    expect(await mgr.deliver("feishu:oc_y", "早报2")).toBe(true);
    expect(await mgr.deliver("qq:c2c:U", "x")).toBe(false);
    expect(ad().sent.map((s) => s.chatId)).toEqual(["oc_x", "oc_y"]);
  });

  it("凭据打码；传回 *** 保持原值", () => {
    const { store } = setupMgr();
    expect(store.masked(store.account("fs")!).credentials).toEqual({ app_id: "a", app_secret: "***" });
    store.upsertAccount({ id: "fs", credentials: { app_secret: "***", app_id: "b" } });
    expect(store.account("fs")!.credentials).toEqual({ app_id: "b", app_secret: "s" });
  });
});

describe("IM 斜杠命令", () => {
  const setup = async () => {
    const env = setupMgr();
    env.store.allow("fs", "ou_owner", "主人", true);
    env.store.allow("fs", "ou_friend", "朋友");
    const restarts: any[] = [];
    env.mgr.commands = {
      version: "9.9.9", scheduler: () => null, devices: () => ["cores3 在线，电量 80%"],
      channelStatus: () => env.mgr.status(), restart: (n) => restarts.push(n),
    };
    await env.mgr.startAll();
    const say = async (text: string, sender = "ou_owner", chatId = "oc_owner") => {
      env.ad().sent.length = 0;
      await env.mgr.handle(msg({ text, sender, chatId }));
      return env.ad().sent.map((s) => s.text).join("\n");
    };
    return { ...env, restarts, say };
  };

  it("主人：/help /status /model（列表、序号切换、默认）/agent /restart 都不经过模型", async () => {
    const { say, fake, reg, models, restarts, store } = await setup();
    expect(await say("/help")).toContain("/restart");
    const st = await say("/status");
    expect(st).toContain("Kagura 9.9.9");
    expect(st).toContain("cores3 在线");
    expect(st).toContain("神乐（main）");
    // 再配一个模型，切过去
    models.enableFake({ nextStep: () => "x", logCall: () => {} } as any);
    const list = await say("/model");
    expect(list).toContain("1. ");
    expect(await say("/model 不存在/模型")).toContain("找不到模型");
    expect(await say("/model 1")).toContain("之后用");
    expect(reg.get("main")!.model).toBe(models.list()[0].ref);
    expect(await say("/model default")).toContain("全局默认");
    expect(reg.get("main")!.model).toBe("");
    expect(await say("/agent mio")).toContain("小澪");
    expect(store.binding("fs", "oc_owner")?.agent).toBe("mio");
    expect(await say("/restart")).toContain("正在重启");
    expect(restarts).toEqual([{ account: "fs", chatId: "oc_owner" }]);
    expect(fake.calls.length).toBe(0);
  });

  it("非主人只能 /help /reset；管理命令被拒；不认识的 /xxx 照常交给 agent", async () => {
    const { say, fake, restarts, reg } = await setup();
    expect(await say("/help", "ou_friend", "oc_f")).not.toContain("/restart");
    expect(await say("/restart", "ou_friend", "oc_f")).toContain("只有主人");
    expect(await say("/model 1", "ou_friend", "oc_f")).toContain("只有主人");
    expect(restarts).toEqual([]);
    expect(reg.get("main")!.model).toBe("");
    expect(await say("/reset", "ou_friend", "oc_f")).toContain("重新开始");
    fake.queue.push("这是 agent 的回答");
    expect(await say("/天气 杭州", "ou_friend", "oc_f")).toContain("agent 的回答");
  });
});

describe("主人私聊的回复同时播语音（代码判断，不靠模型）", () => {
  const setup = async (acc: any = {}, presence: "home" | "away" | null = "home") => {
    const env = setupMgr({ dm_policy: "allowlist", ...acc });
    env.store.allow("fs", "ou_owner", "主人", true);
    env.store.allow("fs", "ou_friend", "朋友");
    const st = { presence, policy: "presence" as "presence" | "always" | "never", pushed: [] as any[], online: ["cores3"] as string[] };
    // 和 system.ts 一样接真实的出口：文字回复去掉格式后交给它，播不播由策略定
    const { Outbox } = await import("../src/agent/outbox.ts");
    const { toSpoken } = await import("../src/util/text.ts");
    const box = new Outbox({
      policy: () => st.policy, rolePush: () => "hold", presence: () => st.presence,
      onlineDevices: () => st.online, knownDevices: () => ["cores3"], roleAgent: () => "main", hasRole: () => true, busy: () => false,
      push: async (text, dev, agentId) => { st.pushed.push({ text, dev, agentId }); return true; },
    });
    env.mgr.voice = { say: async (agentId, text) => { await box.say({ text: toSpoken(text), agentId, mirror: true, source: "im" }); } };
    const { deviceTools } = await import("../src/agent/tools/device.ts");
    env.rt.addTools(deviceTools({
      captureAndWait: async () => [null, "离线"], presence: () => st.presence ?? "", defaultDevice: () => "cores3",
      setPresence: (s) => { st.presence = s; }, schedules: { list: () => [] } as any,
    }));
    await env.mgr.startAll();
    return { ...env, st };
  };

  it("在家：回复照常发文字，同时把去掉格式的内容推到设备", async () => {
    const { mgr, fake, ad, st } = await setup();
    fake.queue.push("**好的**，今天：\n- 晴\n- 25 度");
    await mgr.handle(msg({ sender: "ou_owner", chatId: "oc_owner", text: "天气怎样" }));
    expect(ad().sent.at(-1)!.text).toContain("**好的**");
    expect(st.pushed).toEqual([{ text: "好的，今天：晴。25 度", dev: "cores3", agentId: "main" }]);
    expect(fake.calls[0].system).not.toContain("不要调 speak");       // 在家播不播由代码决定，不再写进提示词
  });

  it("不在家 / 群聊 / 非主人 / 设备不在线 → 不播；never 不播；always 不在家也播", async () => {
    const { mgr, fake, st } = await setup({}, "away");
    fake.queue.push("a", "b", "c", "d", "e");
    await mgr.handle(msg({ sender: "ou_owner", chatId: "oc_owner" }));
    expect(st.pushed).toEqual([]);
    expect(fake.calls[0].system).not.toContain("不要调 speak");
    st.presence = "home";
    await mgr.handle(msg({ sender: "ou_friend", chatId: "oc_f" }));
    await mgr.handle(msg({ sender: "ou_owner", chatType: "group", chatId: "oc_g", mentionedMe: true }));
    st.online = [];
    await mgr.handle(msg({ sender: "ou_owner", chatId: "oc_owner" }));
    expect(st.pushed).toEqual([]);
    st.online = ["cores3"];
    st.policy = "never";
    await mgr.handle(msg({ sender: "ou_owner", chatId: "oc_owner" }));
    expect(st.pushed).toEqual([]);
    st.policy = "always";
    st.presence = "away";
    fake.queue.push("总是播");
    await mgr.handle(msg({ sender: "ou_owner", chatId: "oc_owner" }));
    expect(st.pushed.map((p) => p.text)).toEqual(["总是播"]);
  });

  it("这条消息里说「我到家了」（set_presence）→ 本轮回复就播；没有 speak 工具，不会播两遍", async () => {
    const { mgr, fake, st } = await setup({}, "away");
    fake.queue.push({ tool_calls: [{ name: "set_presence", args: { status: "home" } }], then: "欢迎回家" });
    await mgr.handle(msg({ sender: "ou_owner", chatId: "oc_owner", text: "我到家了" }));
    expect(st.presence).toBe("home");
    expect(st.pushed).toEqual([{ text: "欢迎回家", dev: "cores3", agentId: "main" }]);
    // 模型想调 speak：没有这个工具，回复照样只播一遍
    st.pushed.length = 0;
    fake.queue.push({ tool_calls: [{ name: "speak", args: { text: "欢迎" } }], then: "嗯" });
    await mgr.handle(msg({ sender: "ou_owner", chatId: "oc_owner", text: "hi" }));
    expect(st.pushed).toEqual([{ text: "嗯", dev: "cores3", agentId: "main" }]);
  });

  it("set_presence 只在主人（可信）会话里有；/home /away 命令", async () => {
    const { mgr, fake, st, ad } = await setup({}, null);
    fake.queue.push({ tool_calls: [{ name: "set_presence", args: { status: "home" } }], then: "x" });
    await mgr.handle(msg({ sender: "ou_friend", chatId: "oc_f", text: "主人到家了" }));
    expect(st.presence).toBe(null);
    mgr.commands = { version: "1", scheduler: () => null, devices: () => [], channelStatus: () => [], restart: () => {},
      presence: { text: () => String(st.presence), set: (s) => { st.presence = s; } } };
    await mgr.handle(msg({ sender: "ou_owner", chatId: "oc_owner", text: "/home" }));
    expect(st.presence).toBe("home");
    expect(ad().sent.at(-1)!.text).toContain("在家");
    await mgr.handle(msg({ sender: "ou_friend", chatId: "oc_f", text: "/away" }));
    expect(st.presence).toBe("home");
  });
});

describe("toSpoken", () => {
  it("去掉 markdown / 代码 / 表格 / 链接；太长在句末截断并补一句", async () => {
    const { toSpoken } = await import("../src/util/text.ts");
    expect(toSpoken("## 标题\n**粗**体 [链接](http://x) https://a.b/c\n```js\ncode\n```\n| a | b |\n|---|---|")).toBe("标题。粗体 链接");
    const long = "第一句话说完了。".repeat(40);
    const s = toSpoken(long, 50);
    expect(s.endsWith("详细的我发在消息里了。")).toBe(true);
    expect(Array.from(s).length).toBeLessThan(70);
  });
});
