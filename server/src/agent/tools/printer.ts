// 打印机状态（只读）。只在配了打印机时才有这个工具；只给可信会话（家里的设备，toolpolicy 里也锁着不给群聊）。
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { RunScope } from "../scope.ts";
import type { PrinterHub } from "../../printer/hub.ts";
import { ok } from "./device.ts";

export function printerTools(hub: PrinterHub) {
  return (scope: RunScope): AgentTool<any>[] => {
    if (!scope.trusted || !hub.count) return [];
    return [{
      name: "printer_status", label: "看 3D 打印机",
      description: "看家里 3D 打印机现在的情况：在不在打印、打的是什么、进度、还要多久、温度、料还剩多少、有没有报错。只能看，不能控制（暂停 / 停止 / 开始打印要主人自己在打印机或官方软件上操作）。"
        + "打完、失败、暂停时系统会自动通知主人，不用你盯着。",
      parameters: Type.Object({ printer: Type.Optional(Type.String({ description: "有多台时填名字；不填 = 全部" })) }),
      async execute(_id, p: any) { return ok(hub.describe(String(p?.printer ?? ""))); },
    }];
  };
}
