// 设备相关的内置工具（§6.9）：speak / take_photo / set_volume / get_presence / photo_schedule_*。
// 替代 OpenClaw 的 cores3-speak、cores3-camera skill 和 [PHOTO] 前缀约定。
import fs from "node:fs";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { RunScope } from "../scope.ts";
import type { AgentInfo } from "../registry.ts";
import type { PhotoSchedules } from "../../jobs/photoSchedules.ts";

export interface DeviceHost {
  push(text: string, dev: string, per: number): Promise<boolean>;
  captureAndWait(dev: string): Promise<[string | null, string | null]>;
  presence(): string;
  /** 主人亲口说的在家 / 出门（设备蓝牙没感知到时补上） */
  setPresence(status: "home" | "away"): void;
  schedules: PhotoSchedules;
  defaultDevice(): string;
}

export const ok = (text: string, details: any = {}) => ({ content: [{ type: "text" as const, text }], details });
export const fail = (text: string) => ({ content: [{ type: "text" as const, text }], details: {}, isError: true });

const DEV_RE = /^[a-zA-Z0-9_-]{1,32}$/;

export function deviceTools(host: DeviceHost) {
  return (scope: RunScope, agent: AgentInfo): AgentTool<any>[] => {
    /** 本轮回复会被直接播报到哪台设备（/chat 里就是说话的那台） */
    const spokenTo = scope.spokenTo;
    const target = (d?: string) => (d && DEV_RE.test(d) ? d : scope.deviceId || host.defaultDevice());
    return [
      {
        name: "speak", label: "播报",
        description: "让设备用你的声音说一句话（主动开口、跨渠道传话）。正在和你语音对话时不用调，你的回复本身就会播出来。",
        parameters: Type.Object({ text: Type.String({ description: "要说的话，口语、简短" }), device: Type.Optional(Type.String()) }),
        async execute(_id, p: any) {
          const dev = target(p.device);
          if (dev === spokenTo) return ok("你这轮的回复本身就会在这台设备上播出来，不用再调 speak，直接回复要说的话即可。");
          const done = await host.push(String(p.text), dev, agent.per);
          (scope.meta.spoke ??= []).push(String(p.text));
          return done ? ok(`已在 ${dev} 上播报`) : fail("播报失败：设备不在线或语音合成失败");
        },
      },
      {
        name: "take_photo", label: "拍照",
        description: "用设备摄像头拍一张照片来看。主人让你看东西、问「这是什么」「我手里拿的什么」时调用。",
        parameters: Type.Object({ question: Type.String({ description: "看照片要回答的问题" }), device: Type.Optional(Type.String()) }),
        async execute(_id, p: any) {
          const dev = target(p.device);
          if (scope.channel === "device" && dev === spokenTo) {
            // 设备是单线程的：/chat 进行中收不了拍照命令。本轮立即结束、带 X-Need-Photo 回去，
            // 设备拍完把照片连同原问题发 /chat-vision，作为下一条消息交给你（固件零改动）
            scope.meta.needPhoto = true;
            return { ...ok("已让设备拍照，照片会随下一条消息发给你。现在先简短回应一句（比如「我看看」）。"), terminate: true };
          }
          const [img, err] = await host.captureAndWait(dev);
          if (err || !img) return fail(`拍照失败：${err}`);
          const data = fs.readFileSync(img).toString("base64");
          (scope.meta.photos ??= []).push(img);      // IM 渠道里：照片随回复发回聊天
          return { content: [{ type: "text" as const, text: `照片（${dev}）：${p.question}` }, { type: "image" as const, data, mimeType: "image/jpeg" }], details: { image_path: img } };
        },
      },
      {
        name: "set_volume", label: "调音量",
        description: "调大或调小设备音量（只在语音对话里有效）。",
        parameters: Type.Object({ direction: Type.Union([Type.Literal("up"), Type.Literal("down")]) }),
        async execute(_id, p: any) {
          if (scope.channel !== "device" || !spokenTo) return fail("只有在设备语音对话里才能调音量");
          scope.meta.volume = p.direction;
          return ok(p.direction === "up" ? "音量已调大" : "音量已调小");
        },
      },
      {
        name: "get_presence", label: "在家状态",
        description: "查主人现在在不在家（设备通过蓝牙感知手机）。",
        parameters: Type.Object({}),
        async execute() { return ok(host.presence() || "不知道（设备还没上报过）"); },
      },
      // 只在可信会话（主人本人）里有：陌生人说一句「主人到家了」不能改掉状态
      ...(scope.trusted ? [{
        name: "set_presence", label: "记下在家状态",
        description: "主人明确说自己到家了 / 出门了（「我到家了」「我出门了」）时调用，更新在家状态。"
          + "在家时主人在聊天软件里的消息，你的回复会自动同时在家里设备上用语音播出来。只凭主人本人明确的说法，别猜。",
        parameters: Type.Object({ status: Type.Union([Type.Literal("home"), Type.Literal("away")]) }),
        async execute(_id: string, p: any) {
          host.setPresence(p.status);
          return ok(p.status === "home" ? "已记下：主人在家" : "已记下：主人不在家");
        },
      } as AgentTool<any>] : []),
      {
        name: "photo_schedule_list", label: "定时拍照列表",
        description: "列出每日定时拍照计划（到点拍照、识别并播报）。",
        parameters: Type.Object({}),
        async execute() { return ok(JSON.stringify(host.schedules.list())); },
      },
      {
        name: "photo_schedule_add", label: "新增定时拍照",
        description: "新增每日定时拍照：每天 time（HH:MM）拍一张，按 prompt 识别并播报。",
        parameters: Type.Object({ time: Type.String(), prompt: Type.Optional(Type.String()), device: Type.Optional(Type.String()) }),
        async execute(_id, p: any) {
          try { return ok(JSON.stringify(host.schedules.add(p.time, target(p.device), p.prompt ?? ""))); }
          catch (e: any) { return fail(e.message); }
        },
      },
      {
        name: "photo_schedule_update", label: "修改定时拍照",
        description: "修改定时拍照计划：可改 time / prompt / enabled。",
        parameters: Type.Object({ id: Type.String(), time: Type.Optional(Type.String()), prompt: Type.Optional(Type.String()), enabled: Type.Optional(Type.Boolean()) }),
        async execute(_id, p: any) {
          const { id, ...fields } = p;
          try {
            const it = host.schedules.update(id, fields);
            return it ? ok(JSON.stringify(it)) : fail("没有这个计划");
          } catch (e: any) { return fail(e.message); }
        },
      },
      {
        name: "photo_schedule_remove", label: "删除定时拍照",
        description: "删除一个定时拍照计划。",
        parameters: Type.Object({ id: Type.String() }),
        async execute(_id, p: any) { return host.schedules.remove(p.id) ? ok("已删除") : fail("没有这个计划"); },
      },
    ];
  };
}
