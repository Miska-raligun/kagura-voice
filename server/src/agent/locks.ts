// 会话锁：同一会话的轮次串行、排队计数；全局并发名额。从 runtime.ts 拆出来的。

export class Semaphore {
  private queue: (() => void)[] = [];
  constructor(private n: number) {}
  async acquire() {
    if (this.n > 0) { this.n--; return; }
    await new Promise<void>((r) => this.queue.push(r));
  }
  release() {
    const next = this.queue.shift();
    if (next) next(); else this.n++;
  }
}

export class SessionLocks {
  private locks = new Map<string, Promise<unknown>>();
  /** 每个会话后面排着几轮 */
  queued = new Map<string, number>();

  /** who：排队太久时日志里说清楚是谁占着（由运行时给出正在跑的那一轮的描述） */
  constructor(private who: (key: string) => string) {}

  /** 同一会话串行。前面那轮迟迟不完就打一行日志，说清楚是谁占着（以前这种情况一声不吭，看起来就是「这个 agent 不理人了」） */
  serial<T>(key: string, fn: () => Promise<T>, waitMs = 0, busyMsg = ""): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    if (this.locks.has(key)) {
      this.queued.set(key, (this.queued.get(key) ?? 0) + 1);
      prev.catch(() => {}).finally(() => { const n = (this.queued.get(key) ?? 1) - 1; if (n > 0) this.queued.set(key, n); else this.queued.delete(key); });
      const t = setTimeout(() => {
        const who = this.who(key);
        console.log(`[agent] ⏳  ${key} 在排队：上一轮还没结束（${who}）`);
      }, 20_000);
      t.unref?.();
      prev.finally(() => clearTimeout(t));
    }
    const gate = prev.catch(() => {});
    let run: Promise<T>;
    let tail: Promise<unknown>;
    if (waitMs > 0 && this.locks.has(key)) {
      // 等锁有上限：等不到就放弃，但排着的这个位置要等前面真的完了才让给下一个，不然后面的会插队、两轮同时跑
      let gaveUp = false, timer: ReturnType<typeof setTimeout> | undefined;
      const limit = new Promise<void>((r) => { timer = setTimeout(() => { gaveUp = true; r(); }, waitMs); });
      run = Promise.race([gate, limit]).then(() => {
        clearTimeout(timer);
        if (gaveUp) throw new Error(busyMsg || `会话 ${key} 正忙，等了 ${Math.round(waitMs / 1000)} 秒还没轮到`);
        return fn();
      });
      tail = Promise.all([gate, run.catch(() => {})]);
    } else {
      run = gate.then(fn);
      tail = run.catch(() => {});
    }
    this.locks.set(key, tail);
    tail.then(() => { if (this.locks.get(key) === tail) this.locks.delete(key); });
    return run;
  }

  /** 这个会话是否有一轮在跑 / 在排 */
  busy(key: string) { return this.locks.has(key); }

  /** 等这个会话前面排着的都跑完 */
  async whenIdle(key: string): Promise<void> {
    for (let p = this.locks.get(key); p; p = this.locks.get(key)) await p.catch(() => {});
  }
}
