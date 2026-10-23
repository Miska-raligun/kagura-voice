import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { parseConfigPy, migratePython } from "../src/migrate.ts";
import { tmpdir } from "./helpers.ts";

const PY = `BAIDU_API_KEY = "ak"
BAIDU_SECRET_KEY = 'sk'  # 注释
BAIDU_TTS_API_KEY = "tak"
BAIDU_TTS_SECRET_KEY = "tsk"
API_TOKEN = ""
# ROLES = [ {"id": "x"} ]
ROLES = [
    {"id": "",     "name": "神乐", "agent": "main", "per": 111, "aliases": ['kagura']},  # 默认
    {'id': 'mio',  'name': '小澪', 'agent': 'mio',  'per': 4,   'aliases': ["小玲", "小零"],},
]
`;

describe("从 Python 版迁移", () => {
  it("解析 config.py：字符串赋值、单双引号、注释、ROLES 列表（尾逗号、单引号）", () => {
    const c = parseConfigPy(PY);
    expect(c).toMatchObject({ BAIDU_API_KEY: "ak", BAIDU_SECRET_KEY: "sk", API_TOKEN: "" });
    expect(c.ROLES).toEqual([
      { id: "", name: "神乐", agent: "main", per: 111, aliases: ["kagura"] },
      { id: "mio", name: "小澪", agent: "mio", per: 4, aliases: ["小玲", "小零"] },
    ]);
    expect(parseConfigPy(`BAIDU_API_KEY = "x"\n# ROLES = []\n`).ROLES).toBeUndefined();
  });

  it("迁移：config.json、状态文件、快照与 TTS 缓存；已有的不覆盖", () => {
    const from = tmpdir("old"), data = tmpdir("data");
    fs.writeFileSync(path.join(from, "voice_server.py"), "");
    fs.writeFileSync(path.join(from, "config.py"), PY);
    fs.writeFileSync(path.join(from, "reminders.json"), "[]");
    fs.mkdirSync(path.join(from, "tts_cache"));
    fs.writeFileSync(path.join(from, "tts_cache", "a.wav"), "x");
    fs.writeFileSync(path.join(data, "config.json"), JSON.stringify({ api_token: "keep" }));
    const log = migratePython(from, data);
    const cfg = JSON.parse(fs.readFileSync(path.join(data, "config.json"), "utf8"));
    expect(cfg.baidu).toEqual({ asr_key: "ak", asr_secret: "sk", tts_key: "tak", tts_secret: "tsk" });
    expect(cfg.api_token).toBe("keep");
    expect(cfg.roles.length).toBe(2);
    expect(fs.existsSync(path.join(data, "reminders.json"))).toBe(true);
    expect(fs.existsSync(path.join(data, "tts_cache", "a.wav"))).toBe(true);
    expect(log.join("\n")).toContain("2 个角色");
    expect(() => migratePython(data, data)).toThrow(/不像旧版/);
  });
});
