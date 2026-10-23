// 从旧版（Python voice_server.py 的仓库目录）迁移到新服务端的数据目录（§8 第 3 条）。
// 安装包用户没有 Python，所以这里用 TS 再实现一遍 tools/migrate_to_server.py：
//   config.py → config.json（百度 Key、API_TOKEN、STREAM_TOKEN、ROLES）
//   reminders.json / photo_schedules.json / roles_state.json / snapshots/ / tts_cache/ / device_logs/ 原样复制
// TTS 缓存 key 两版逐字节一致，复制过来能省掉重复合成的费用。已存在的文件不覆盖（除非 force）。
import fs from "node:fs";
import path from "node:path";

/** 解析 config.py 里的简单赋值：NAME = "..." / '...'，以及 ROLES = [ {...}, ... ] */
export function parseConfigPy(src: string): Record<string, any> {
  const out: Record<string, any> = {};
  const lines = src.split(/\r?\n/);
  for (const ln of lines) {
    const m = ln.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(["'])(.*)\2\s*(#.*)?$/);
    if (m) out[m[1]] = m[3];
  }
  const start = lines.findIndex((l) => /^ROLES\s*=\s*\[/.test(l));
  if (start >= 0) {
    let depth = 0, buf = "";
    for (let i = start; i < lines.length; i++) {
      const l = lines[i].replace(/#.*$/, (c) => (/["']/.test(c) ? c : ""));
      buf += l + "\n";
      for (const ch of l) depth += ch === "[" ? 1 : ch === "]" ? -1 : 0;
      if (depth <= 0 && buf.includes("]")) break;
    }
    const lit = buf.replace(/^ROLES\s*=\s*/, "")
      .replace(/'([^'\\]*)'/g, (_, s) => JSON.stringify(s))
      .replace(/\bTrue\b/g, "true").replace(/\bFalse\b/g, "false").replace(/\bNone\b/g, "null")
      .replace(/,\s*([\]}])/g, "$1");
    try { out.ROLES = JSON.parse(lit); } catch (e: any) { throw new Error(`config.py 的 ROLES 解析失败（手动写进 config.json 的 roles）：${e.message}`); }
  }
  return out;
}

function copyDir(src: string, dst: string, force: boolean): number {
  if (!fs.existsSync(src)) return 0;
  fs.mkdirSync(dst, { recursive: true });
  let n = 0;
  for (const f of fs.readdirSync(src)) {
    const s = path.join(src, f), d = path.join(dst, f);
    if (!fs.statSync(s).isFile() || (fs.existsSync(d) && !force)) continue;
    fs.copyFileSync(s, d);
    n++;
  }
  return n;
}

export function migratePython(from: string, dataDir: string, force = false): string[] {
  const log: string[] = [];
  if (!fs.existsSync(path.join(from, "voice_server.py"))) throw new Error(`${from} 不像旧版目录（没有 voice_server.py）`);
  fs.mkdirSync(dataDir, { recursive: true });
  const cfgFile = path.join(dataDir, "config.json");
  const cur = fs.existsSync(cfgFile) ? JSON.parse(fs.readFileSync(cfgFile, "utf8")) : {};
  const py = path.join(from, "config.py");
  if (fs.existsSync(py)) {
    const c = parseConfigPy(fs.readFileSync(py, "utf8"));
    const next: any = { ...cur };
    const set = (k: string, v: any) => { if (v !== undefined && v !== "" && (force || next[k] === undefined)) next[k] = v; };
    set("baidu", { asr_key: c.BAIDU_API_KEY ?? "", asr_secret: c.BAIDU_SECRET_KEY ?? "", tts_key: c.BAIDU_TTS_API_KEY ?? "", tts_secret: c.BAIDU_TTS_SECRET_KEY ?? "" });
    set("api_token", c.API_TOKEN);
    set("stream_token", c.STREAM_TOKEN);
    set("roles", c.ROLES);
    fs.writeFileSync(cfgFile, JSON.stringify(next, null, 2));
    log.push(`config.py → ${cfgFile}${c.ROLES ? `（含 ${c.ROLES.length} 个角色）` : ""}`);
  } else log.push("没有 config.py，跳过配置");
  for (const f of ["reminders.json", "photo_schedules.json", "roles_state.json"]) {
    const s = path.join(from, f), d = path.join(dataDir, f);
    if (!fs.existsSync(s)) continue;
    if (fs.existsSync(d) && !force) { log.push(`${f} 已存在，跳过`); continue; }
    fs.copyFileSync(s, d);
    log.push(`复制 ${f}`);
  }
  for (const dir of ["snapshots", "tts_cache", "device_logs", "crash_reports"]) {
    const n = copyDir(path.join(from, dir), path.join(dataDir, dir), force);
    if (n) log.push(`复制 ${dir}/ ${n} 个文件`);
  }
  return log;
}
