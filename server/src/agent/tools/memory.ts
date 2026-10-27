// 记忆工具：memory_search / memory_get / memory_write（§6.4），以及压缩前的「记忆冲刷」。
import fs from "node:fs";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { RunScope } from "../scope.ts";
import type { AgentInfo } from "../registry.ts";
import type { Runtime } from "../runtime.ts";
import { MemoryIndex, type Embedder } from "../memory.ts";
import { resolveInside } from "../paths.ts";
import { ok, fail } from "./device.ts";
import { SOUL_FILES } from "../registry.ts";

export const FLUSH_PROMPT = "[系统] 这段对话马上要被压缩成摘要，较早的细节会丢失。"
  + "把其中值得长期记住、而记忆里还没有的事用 memory_write 记下来（主人的偏好、约定、待办、重要的日子与事实）："
  + "长期稳定的写 long，当天发生的写 daily。没有需要记的就只回 NO_REPLY。不要和用户说话。";

/** 每个 agent 一个索引，复用该 agent 的 agent.sqlite */
export class Memories {
  private idx = new Map<string, MemoryIndex>();
  constructor(private rt: Runtime, private embedder: Embedder | null) {}

  /** 管理界面改了嵌入接口：换掉并丢弃已打开的索引（下次检索按新接口补算向量） */
  setEmbedder(e: Embedder | null) { this.embedder = e; this.idx.clear(); }

  of(agentId: string): MemoryIndex {
    let m = this.idx.get(agentId);
    if (!m) {
      const a = this.rt.agents.get(agentId);
      if (!a) throw new Error(`没有 agent ${agentId}`);
      m = new MemoryIndex(a, this.rt.store(agentId).db, this.embedder);
      this.idx.set(agentId, m);
    }
    return m;
  }

  forget(agentId: string) { this.idx.delete(agentId); }

  /** 只允许人设文件（MEMORY.md、USER.md……）和 memory/ 下的 .md：memory_get 不是通用读文件工具 */
  static memoryPath(agent: AgentInfo, rel: string) {
    const norm = rel.replace(/\\/g, "/").replace(/^\.\//, "");
    if (!(SOUL_FILES as readonly string[]).includes(norm) && !/^memory\/[^/]+\.md$/.test(norm)) throw new Error("只能读人设文件（MEMORY.md、USER.md 等）或 memory/ 下的笔记");
    return resolveInside(agent.workspace, norm);
  }

  tools() {
    // 记忆是主人的私事：群聊、陌生人的会话里既不能翻（套话），也不能写（往记忆里塞东西，以后每轮都带着）
    return (scope: RunScope, agent: AgentInfo): AgentTool<any>[] => !scope.trusted ? [] : [
      {
        name: "memory_search", label: "搜索记忆",
        description: "在你的长期记忆（MEMORY.md）和每日笔记里搜索。回答涉及以前的事、主人的偏好、约定时先搜一下。",
        parameters: Type.Object({ query: Type.String(), k: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })) }),
        execute: async (_id, p: any) => {
          const hits = await this.of(agent.id).search(String(p.query), p.k ?? 6);
          if (!hits.length) return ok("没有找到相关记忆。");
          return ok(hits.map((h) => `[${h.path}#L${h.start}-${h.end}] ${h.text}`).join("\n\n"), { hits });
        },
      },
      {
        name: "memory_get", label: "读取记忆",
        description: "读取记忆或人设文件（MEMORY.md、USER.md、SOUL.md 等，或 memory/YYYY-MM-DD.md），可指定起始行与行数。",
        parameters: Type.Object({ path: Type.String(), from: Type.Optional(Type.Number()), lines: Type.Optional(Type.Number()) }),
        execute: async (_id, p: any) => {
          try {
            const f = Memories.memoryPath(agent, String(p.path));
            if (!fs.existsSync(f)) return fail("没有这个文件");
            const all = fs.readFileSync(f, "utf8").split(/\r?\n/);
            const from = Math.max(1, Math.trunc(p.from ?? 1));
            const n = Math.min(400, Math.max(1, Math.trunc(p.lines ?? 200)));
            return ok(all.slice(from - 1, from - 1 + n).join("\n"));
          } catch (e: any) { return fail(e.message); }
        },
      },
      {
        name: "memory_write", label: "写入记忆",
        description: "记下一件事。target=long 写进长期记忆 MEMORY.md（稳定的偏好与事实），target=daily 写进今天的笔记（当天发生的事）。一次一条，简洁。",
        parameters: Type.Object({ target: Type.Union([Type.Literal("daily"), Type.Literal("long")]), text: Type.String() }),
        execute: async (_id, p: any) => {
          if (scope.kind === "sub") return fail("子任务不能写记忆，把要记的事写进结果里交给发起方");
          try { return ok(`已记到 ${this.of(agent.id).write(p.target, String(p.text))}`); }
          catch (e: any) { return fail(e.message); }
        },
      },
    ];
  }

  /** 压缩前跑一轮静默的冲刷：只给 memory_write，不落盘、不回复用户 */
  async flush(agent: AgentInfo, sessionKey: string) {
    await this.rt.runUnlocked({
      agentId: agent.id, sessionKey, kind: "main", channel: "system", purpose: "flush", persist: false,
      noTurnContext: true, text: FLUSH_PROMPT, toolAllow: (n) => n === "memory_write",
    });
  }
}
