import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DeviceFiles, checkPath } from "../src/devicefiles.ts";
import { tmpdir } from "./helpers.ts";

const jpg = (fill: string) => Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from(fill + "jpegdata")]);
const make = () => new DeviceFiles(path.join(tmpdir("devfiles"), "device_files"), { "src/app.py": Buffer.from("print('builtin')\n"), "src/cfg.py": Buffer.from("X = 1\n") }, "1.2.3");

describe("DeviceFiles", () => {
  it("只认 src/<模块>.py 和 resource/[角色/]<图名>.jpg", () => {
    for (const ok of ["src/app.py", "resource/img_bg.jpg", "resource/mio/img_bg.jpg"]) expect(checkPath(ok)).toBe(ok);
    for (const bad of ["../x.py", "src/../../etc.py", "src/a/b.py", "resource/a/b/c.jpg", "resource/x.png", "main.py", "src/App.py", "/src/app.py", "resource/小澪/img_bg.jpg"]) {
      expect(() => checkPath(bad)).toThrow(/路径/);
    }
  });

  it("清单：自定义覆盖内置，按路径排序，scope 分开", () => {
    const f = make();
    f.put("resource/img_bg.jpg", jpg("a"));
    f.put("src/app.py", Buffer.from("print('custom')\n"));
    const all = f.list();
    expect(all.map((e) => e.p)).toEqual(["resource/img_bg.jpg", "src/app.py", "src/cfg.py"]);
    expect(all.find((e) => e.p === "src/app.py")!.source).toBe("custom");
    expect(f.manifest("res").files.map((e) => e.p)).toEqual(["resource/img_bg.jpg"]);
    expect(f.manifest("code").files.map((e) => e.p)).toEqual(["src/app.py", "src/cfg.py"]);
    expect(f.read("src/app.py")!.toString()).toContain("custom");
    expect(f.manifest("code").version).toBe("1.2.3");
  });

  it("指纹算法与设备端 ota._rev 一致（sha256 of p:h 逐行，前 12 位）", () => {
    const f = make();
    const m = f.manifest("code");
    const want = crypto.createHash("sha256").update(m.files.map((e) => `${e.p}:${e.h}`).join("\n")).digest("hex").slice(0, 12);
    expect(m.rev).toBe(want);
    f.put("src/app.py", Buffer.from("changed\n"));
    expect(f.manifest("code").rev).not.toBe(want);
  });

  it("删掉覆盖回到内置；内置本身删不掉", () => {
    const f = make();
    expect(f.remove("src/app.py")).toBe(false);
    f.put("src/app.py", Buffer.from("x\n"));
    expect(f.remove("src/app.py")).toBe(true);
    expect(f.read("src/app.py")!.toString()).toContain("builtin");
  });

  it("角色目录图片：删到空目录顺手清掉", () => {
    const f = make();
    f.put("resource/mio/img_bg.jpg", jpg("m"));
    expect(fs.existsSync(path.join(f.root, "resource", "mio"))).toBe(true);
    f.remove("resource/mio/img_bg.jpg");
    expect(fs.existsSync(path.join(f.root, "resource", "mio"))).toBe(false);
  });

  it("内容校验：图片必须是 JPEG 且不过大；代码必须是 UTF-8", () => {
    const f = make();
    expect(() => f.put("resource/img_bg.jpg", Buffer.from("\x89PNG...."))).toThrow(/JPEG/);
    expect(() => f.put("resource/img_bg.jpg", Buffer.concat([jpg(""), Buffer.alloc(300 * 1024)]))).toThrow(/太大/);
    expect(() => f.put("src/x.py", Buffer.from([0xff, 0xfe, 0x00]))).toThrow(/UTF-8/);
  });
});
