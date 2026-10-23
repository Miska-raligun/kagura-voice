import { describe, it, expect } from "vitest";
import { wslUncPath, toLinuxPath, isWsl } from "../src/util/platform.ts";
import { OpenClawBrain } from "../src/brain/openclaw.ts";
import { loadConfig } from "../src/config.ts";
import { tmpdir } from "./helpers.ts";

describe("WSL 相关", () => {
  it("Linux 路径 ↔ \\\\wsl.localhost 路径", () => {
    const unc = wslUncPath("Ubuntu", "/home/u/.openclaw/workspace/tmp");
    expect(unc).toBe("\\\\wsl.localhost\\Ubuntu\\home\\u\\.openclaw\\workspace\\tmp");
    expect(toLinuxPath(`${unc}\\oc_vision_ab.jpg`, unc, "/home/u/.openclaw/workspace/tmp")).toBe("/home/u/.openclaw/workspace/tmp/oc_vision_ab.jpg");
    expect(toLinuxPath("C:\\other\\x.jpg", unc, "/x")).toBe("C:\\other\\x.jpg");
  });

  it("Windows 版接 WSL 里的 OpenClaw：经 wsl.exe -d <发行版> -e 执行，照片路径换成 Linux 路径", () => {
    const b = new OpenClawBrain("/home/u/.npm-global/bin/openclaw", { distro: "Ubuntu", toAgentPath: (p) => p.replace("W:", "/l") });
    expect(b.command(["agent", "--agent", "main"])).toEqual(["wsl.exe", ["-d", "Ubuntu", "-e", "/home/u/.npm-global/bin/openclaw", "agent", "--agent", "main"]]);
    expect(new OpenClawBrain("/usr/bin/openclaw").command(["agent"])).toEqual(["/usr/bin/openclaw", ["agent"]]);
  });

  it("WSL 里默认多开一个只绑本机的管理端口 5080；可用 admin_port / KAGURA_ADMIN_PORT 覆盖", () => {
    const d = tmpdir();
    expect(loadConfig({ KAGURA_DATA_DIR: d }).adminPort).toBe(isWsl() ? 5080 : 0);
    expect(loadConfig({ KAGURA_DATA_DIR: d, WSL_DISTRO_NAME: "Ubuntu" }).adminPort).toBe(process.platform === "linux" ? 5080 : 0);
    expect(loadConfig({ KAGURA_DATA_DIR: d, KAGURA_ADMIN_PORT: "6000" }).adminPort).toBe(6000);
  });
});
