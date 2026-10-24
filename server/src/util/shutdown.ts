// 优雅退出：退出 / 重启 / 在线更新 / 系统发来的结束信号都走这里，先收拾要收拾的再退。
//
// 为什么（LRN 2026-10-24，症状「在线更新之后神乐的飞书十几分钟收不到消息，状态却显示在线」）：
// 以前进程是直接被结束的，飞书长连接没正常断开；飞书服务端不知道它死了，事件继续投给那条死连接，
// 新进程虽然连上了也收不到，要等旧连接租约过期。先 close 长连接再退，飞书立刻改投新连接。
const hooks: { name: string; fn: () => unknown }[] = [];
let exiting = false;

/** 登记退出前要做的事（关 IM 长连接等）。每件最多等 capMs，超时不等 */
export function onShutdown(name: string, fn: () => unknown) { hooks.push({ name, fn }); }

export async function runShutdownHooks(capMs = 3000) {
  const all = hooks.map((h) => Promise.resolve().then(h.fn).catch((e: any) => console.log(`[shutdown] ⚠️  ${h.name}: ${e?.message ?? e}`)));
  await Promise.race([Promise.allSettled(all), new Promise((r) => setTimeout(r, capMs).unref?.())]);
}

/** 收拾完再退出；重复调用只算一次 */
export async function gracefulExit(code = 0, capMs = 3000) {
  if (exiting) return;
  exiting = true;
  await runShutdownHooks(capMs);
  process.exit(code);
}

export function isExiting() { return exiting; }
