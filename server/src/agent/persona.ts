// 共享人设（LRN 2026-10-30，症状「每个 agent 七个人设文件，维护起来太累」）：
// USER.md（主人只有一个）、AGENTS.md（全家的规矩）、TOOLS.md（同一台电脑的环境）全家共用一份，放 <数据目录>/shared_persona/。
// agent 自己的同名文件只写差异，叠加在共享那份后面（和共享重复的行去掉）；没有差异就只用共享的。
// SOUL / IDENTITY / HEARTBEAT / MEMORY 仍然每个 agent 一份。

import fs from "node:fs";
import path from "node:path";

export const SHARED_FILES = ["USER.md", "AGENTS.md", "TOOLS.md"] as const;
export const isShared = (f: string) => (SHARED_FILES as readonly string[]).includes(f);

/** 共享那份的默认内容。工具怎么用由系统提示按她手上的工具自动写（soul.toolGuide），这里不用写 */
export const SHARED_TEMPLATES: Record<string, string> = {
  "USER.md": "# 主人\n\n（主人的称呼、家人、作息、口味与习惯写在这里，所有 agent 共用。）\n",
  "AGENTS.md": "# 守则\n\n（全家 agent 都要遵守的规矩写在这里。工具和系统机制怎么用，系统会自动告诉她们，不用写。）\n",
  "TOOLS.md": "# 工具备注\n\n（这台电脑上的环境与经验：常用路径、查东西去哪个网站、命令怎么跑……所有 agent 共用。）\n",
};

let dir = "";
/** 系统启动时设一次；空 = 不用共享（单测、老布局） */
export function setSharedDir(d: string) {
  dir = d;
  if (!d) return;
  fs.mkdirSync(d, { recursive: true });
  for (const f of SHARED_FILES) if (!fs.existsSync(path.join(d, f))) fs.writeFileSync(path.join(d, f), SHARED_TEMPLATES[f]);
}
export const sharedDir = () => dir;
export const sharedPath = (f: string) => (dir && isShared(f) ? path.join(dir, f) : "");

const read = (p: string) => { try { return fs.readFileSync(p, "utf8"); } catch { return ""; } };
const norm = (l: string) => l.trim();

/** agent 自己那份里真正多出来的：去掉和共享重复的行；只剩标题 / 空行 / 括号说明就算没有 */
export function ownExtra(shared: string, own: string): string {
  const seen = new Set(shared.split(/\r?\n/).map(norm).filter(Boolean));
  const rest = own.split(/\r?\n/).filter((l) => !norm(l) || !seen.has(norm(l)));
  const meaningful = rest.some((l) => { const t = norm(l); return t && !/^#+\s/.test(t) && !/^（.*）$/.test(t); });
  return meaningful ? rest.join("\n").replace(/\n{3,}/g, "\n\n").trim() : "";
}

/** 人设文件实际给她看的内容：共享的 + 她自己补充的 */
export function personaText(ws: string, f: string): string {
  const own = read(path.join(ws, f));
  if (!sharedPath(f)) return own;
  const shared = read(sharedPath(f)).trim();
  const extra = ownExtra(shared, own);
  if (!extra) return shared;
  if (!shared) return extra;
  return `${shared}\n\n## 只对你的补充\n\n${extra.replace(/^#\s.*\n*/, "")}`;
}
