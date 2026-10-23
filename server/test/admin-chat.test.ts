import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { tmpdir, makeRuntime } from "./helpers.ts";
import { saveUploads, safeName } from "../src/routes/admin-chat.ts";

describe("聊天附件", () => {
  it("文件名去掉路径和非法字符（保留中文）", () => {
    expect(safeName("../../etc/passwd")).toBe("passwd");
    expect(safeName("C:\\Users\\a\\报告:v2?.docx")).toBe("报告_v2_.docx");
    expect(safeName("...")).toBe("file");
  });

  it("小文本文件内容直接附进消息，其它文件存进 uploads/ 并说明路径；重名自动加序号", () => {
    const ws = tmpdir("ws");
    const t = saveUploads(ws, [
      { name: "笔记.md", b64: Buffer.from("# 标题\n内容").toString("base64") },
      { name: "data.bin", b64: Buffer.from([0, 1, 2, 3]).toString("base64") },
      { name: "笔记.md", b64: Buffer.from("第二份").toString("base64") },
    ], new Date("2026-10-23T10:00:00"));
    expect(t).toContain('<file name="笔记.md" path="uploads/2026-10-23/笔记.md">\n# 标题\n内容\n</file>');
    expect(t).toContain("[附件 data.bin（0.0KB）已保存到你工作目录下的 uploads/2026-10-23/data.bin");
    expect(t).toContain('name="笔记-2.md"');
    expect(fs.readdirSync(path.join(ws, "uploads", "2026-10-23")).sort()).toEqual(["data.bin", "笔记-2.md", "笔记.md"]);
  });
});

describe("会话标题与删除", () => {
  it("标题取第一条用户消息（去掉时间行）；删除会话连消息一起删", async () => {
    const { rt, fake } = makeRuntime();
    fake.queue.push("好的");
    await rt.run({ agentId: "main", sessionKey: "main:webchat:x1", kind: "chat", channel: "webchat", text: "帮我  写一首\n关于秋天的诗" });
    const st = rt.store("main");
    expect(st.title("main:webchat:x1")).toBe("帮我 写一首 关于秋天的诗");
    expect(st.remove("main:webchat:x1")).toBe(true);
    expect(st.getSession("main:webchat:x1")).toBeUndefined();
    expect(st.transcript("main:webchat:x1")).toEqual([]);
    expect(st.remove("main:webchat:x1")).toBe(false);
  });
});
