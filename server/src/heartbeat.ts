// 设备心跳 / 远程诊断（对应 /heartbeat 一节）。
// 设备每分钟 POST /heartbeat（状态 + 增量 dbg 日志）。日志落盘 device_logs/，
// 失联/恢复在服务端日志留下带时长的记录。
import fs from "node:fs";
import path from "node:path";
import { now, strftime } from "./util/time.ts";

export const HB_SILENT_SECS = 200;   // 超过此秒数无心跳视为失联（心跳间隔 60s）

interface Rec { ts: number; data: Record<string, any>; alerted: boolean }

export function wdtNote(d: Record<string, any>): string {
  const ms = d.wdt;
  if (ms === undefined || ms === null) return "wdt=未知(旧固件)";
  return ms ? `wdt=${Math.floor(ms / 1000)}s` : "wdt=⚠️未武装";
}

function vadNote(d: Record<string, any>): string {
  const v = d.vad;
  return Array.isArray(v) && v.length >= 3 ? ` vad=底噪${v[0]}/说话${v[1]}/唤醒${v[2]}` : "";
}

export class Heartbeats {
  devices = new Map<string, Rec>();
  constructor(private logsDir: string) {}

  logFile(dev: string) { return path.join(this.logsDir, `${dev}.log`); }

  appendLog(dev: string, lines: string[]) {
    fs.appendFileSync(this.logFile(dev), lines.map((l) => l + "\n").join(""), "utf8");
  }

  beat(dev: string, data: Record<string, any>, logs: unknown[]) {
    const t = now();
    const prev = this.devices.get(dev);
    this.devices.set(dev, { ts: t, data, alerted: false });
    const f = (k: string) => (data[k] === undefined ? "None" : String(data[k]));
    if (!prev) {
      console.log(`[${dev}] 💓 心跳开始 heap=${f("heap")} rssi=${f("rssi")} bat=${f("bat")}% chg=${f("chg")} ${wdtNote(data)}${vadNote(data)}`);
    } else if (t - prev.ts > HB_SILENT_SECS) {
      const gap = Math.trunc(t - prev.ts);
      console.log(`[${dev}] 💓 心跳恢复（中断 ${Math.floor(gap / 60)}分${gap % 60}秒） heap=${f("heap")} rssi=${f("rssi")} mqtt=${f("mqtt")} bat=${f("bat")}% chg=${f("chg")} ${wdtNote(data)}`);
    }
    if (logs.length) {
      const stamp = strftime("%Y-%m-%d %H:%M:%S");
      const lines = logs.slice(0, 40).map((l) => String(l).slice(0, 200));
      this.appendLog(dev, lines.map((l) => `[${stamp}] ${l}`));
      for (const l of lines) console.log(`[${dev}] 📟 ${l}`);
    }
  }

  /** 设备发来的任何业务请求都证明它活着：只刷新已知设备的时刻，不动遥测 */
  seen(dev: string) {
    const r = this.devices.get(dev);
    if (r) { r.ts = now(); r.alerted = false; }
  }

  /** 后台巡检：静默超阈值打一条失联记录（每次失联仅一条） */
  watch() {
    const t = now();
    for (const [dev, r] of this.devices) {
      if (t - r.ts > HB_SILENT_SECS && !r.alerted) {
        r.alerted = true;
        console.log(`[${dev}] 🔇 设备失联（最后心跳 ${strftime("%H:%M:%S", new Date(r.ts * 1000))}，heap=${r.data.heap} mqtt=${r.data.mqtt} ${wdtNote(r.data)}）`);
      }
    }
  }
}
