// Windows 上认 WSL 写法的路径（2026-11-28：执行命令交给 WSL 时她写的都是 /mnt/c/…，文件工具以前解析成 C:\mnt\c\…）
import { describe, it, expect } from "vitest";
import { resolvePath } from "../src/agent/tools/files.ts";

describe("resolvePath", () => {
  it("Windows：/mnt/c/… → C:\\…；盘符大小写都认；普通相对 / 绝对路径照旧", () => {
    expect(resolvePath("/mnt/c/app/blender/build.py", "D:\\ws", "win32")).toBe("C:\\app\\blender\\build.py");
    expect(resolvePath("/mnt/D/models", "D:\\ws", "win32")).toBe("D:\\models");
    expect(resolvePath("/mnt/c", "D:\\ws", "win32")).toBe("C:\\");
    expect(resolvePath("models\\a.py", "D:\\ws", "win32")).toBe("D:\\ws\\models\\a.py");
    expect(resolvePath("C:\\x\\y.md", "D:\\ws", "win32")).toBe("C:\\x\\y.md");
  });
  it("Linux 上 /mnt/c 就是 /mnt/c（真在 WSL 里跑的服务端）", () => {
    expect(resolvePath("/mnt/c/app/x.py", "/home/u/ws", "linux")).toBe("/mnt/c/app/x.py");
    expect(resolvePath("a/b.md", "/home/u/ws", "linux")).toBe("/home/u/ws/a/b.md");
  });
});
