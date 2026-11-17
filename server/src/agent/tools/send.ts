// 发文件给主人（send_file）：图片、文档、表格、压缩包……网页会话里显示在对话中（图片直接显示，其它可下载），
// 飞书发成图片 / 文件消息，OneBot（QQ 个人号）只能发图片。只在回复会直接送到人眼前的会话里有（网页聊天、IM），
// 手机 / 平板网页客户端（/app）的对话里也有：文件经推送通道送到页面上。硬件设备的语音对话、待办、定时任务、子任务里没有（发了也没人收）。只给可信会话：它能读这台电脑上的任意文件，陌生人用它就是把文件往外拿。
//
// 文件先复制一份到工作目录 sent/<日期>/：网页上的历史记录一直看得到当时发的那份（原文件后来改了、删了都不影响），
// 管理界面也只从工作目录里取文件。工具结果里带一行 `[文件 sent/…]`，会话页认这行画成附件（不折叠在工具结果里）。
import fs from "node:fs";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { RunScope } from "../scope.ts";
import type { AgentInfo } from "../registry.ts";
import { safeName } from "../paths.ts";
import { resolvePath } from "./files.ts";
import { ok, fail } from "./device.ts";

export interface SentFile { path: string; rel: string; name: string; size: number; image: boolean }
/** 单个文件上限（飞书文件消息的上限也是 30MB） */
export const SEND_MAX_BYTES = 30 * 1024 * 1024;
/** 一轮最多发几个 */
export const SEND_MAX_FILES = 10;
/** 哪些渠道收得到文件；onebot 只收图片 */
const CHANNELS = new Set(["webchat", "feishu", "onebot"]);
export const IMAGE_EXT = /\.(jpe?g|png|webp|gif|bmp)$/i;
/** 工具结果里标附件的那一行（会话页按它画附件） */
export const SENT_MARK = (rel: string) => `[文件 ${rel}]`;
export const SENT_RE = /^\[文件 (sent\/[^\]\n]+)\]$/gm;

const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`);

/** isPhone：这台设备是不是配对的手机 / 平板（它有屏幕能收文件；硬件设备只有喇叭） */
export function sendTools(o: { isPhone?: (deviceId: string) => boolean } = {}) {
  return (scope: RunScope, agent: AgentInfo): AgentTool<any>[] => {
    const phone = scope.channel === "device" && !!scope.deviceId && !!o.isPhone?.(scope.deviceId);
    if (!scope.trusted || scope.kind === "sub" || !(CHANNELS.has(scope.channel) || phone)) return [];
    const imagesOnly = scope.channel === "onebot";
    return [{
      name: "send_file", label: "发文件给主人",
      description: `把一个文件发给主人，跟这条回复一起送到：${imagesOnly ? "这个聊天只能发图片" : "图片直接显示，文档、表格、压缩包等发成文件"}。`
        + "主人要你把文件发过来、或者你做出来的结果本身就是文件（导出的表格、生成的图、整理好的文档）时用，回复里说一句这是什么。"
        + `path 是这台电脑上的文件（绝对路径，或相对你的工作目录）；一次一个，可以调多次（一轮最多 ${SEND_MAX_FILES} 个），单个不超过 ${SEND_MAX_BYTES >> 20}MB。`,
      parameters: Type.Object({ path: Type.String({ description: "要发的文件" }) }),
      async execute(_id, p: any) {
        const src = resolvePath(String(p?.path ?? ""), agent.workspace);
        let st: fs.Stats;
        try { st = await fs.promises.stat(src); } catch { return fail(`没有这个文件：${src}`); }
        if (st.isDirectory()) return fail(`${src} 是目录。要发整个目录就先打包成 zip 再发。`);
        if (!st.isFile()) return fail(`${src} 不是普通文件`);
        if (!st.size) return fail(`${src} 是空文件`);
        if (st.size > SEND_MAX_BYTES) return fail(`${path.basename(src)} 有 ${kb(st.size)}，超过 ${SEND_MAX_BYTES >> 20}MB 发不了。可以压缩一下，或者告诉主人它在哪。`);
        const image = IMAGE_EXT.test(src);
        if (imagesOnly && !image) return fail("这个聊天（QQ 个人号）只能发图片，发不了别的文件。告诉主人文件在哪就好。");
        const sent: SentFile[] = (scope.meta.files ??= []);
        if (sent.length >= SEND_MAX_FILES) return fail(`这一轮已经发了 ${SEND_MAX_FILES} 个文件，别再发了；剩下的打包成 zip 或者告诉主人在哪。`);
        const day = new Date().toLocaleDateString("sv-SE");
        const dir = path.join(agent.workspace, "sent", day);
        await fs.promises.mkdir(dir, { recursive: true });
        const base = safeName(path.basename(src));
        let name = base;
        for (let i = 2; fs.existsSync(path.join(dir, name)); i++) name = base.replace(/(\.[^.]*)?$/, `-${i}$1`);
        const copy = path.join(dir, name);
        await fs.promises.copyFile(src, copy);
        const rel = `sent/${day}/${name}`;
        sent.push({ path: copy, rel, name, size: st.size, image });
        return ok(`已附上 ${name}（${kb(st.size)}），会跟这条回复一起发给主人。\n${SENT_MARK(rel)}`, { file: rel });
      },
    }];
  };
}
