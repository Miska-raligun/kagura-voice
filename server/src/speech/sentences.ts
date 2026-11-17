// 边生成边播（§6.10）：把模型逐字吐出的文本切成句子，每句单独合成语音。
// 句末标点处切；一直不出句号的长句在逗号处切（不让第一声等太久）；太碎的不单独合成。

const END = /[。！？!?；;…\n]/;
const SOFT = /[，,、：:]/;
const MAX_CHARS = 48;       // 超过这么长还没句号，就在最后一个逗号处先切一刀
const MIN_CHARS = 2;        // 「嗯。」这种太短的并进下一句
/** 第一句超过这么长还没句号就在逗号处先切：出声前要等的就是第一句写完，模型一秒二三十字，48 字要等一两秒 */
const FIRST_MAX_CHARS = 14;

/** 这一段是不是在句末标点处结束的（不是在逗号处先切出来的半句） */
export const endsSentence = (s: string) => /[。！？!?；;…\n][”"’'）)】」』\s]*$/.test(s);
/** 半句攒到这么长也当成一句说完了（一直不出句号的长句） */
export const LONG_SENTENCE = MAX_CHARS;

export class SentenceSplitter {
  private buf = "";
  private emitted = 0;
  /** eagerFirst：边生成边播用，第一句尽早切出来（朗读一整段的地方不需要） */
  constructor(private o: { eagerFirst?: boolean } = {}) {}

  /** 喂入一段增量，返回已经完整的句子 */
  push(delta: string): string[] {
    this.buf += delta;
    const out: string[] = [];
    for (;;) {
      const chars = Array.from(this.buf);
      let cut = -1;
      for (let i = 0; i < chars.length; i++) {
        if (END.test(chars[i])) {
          // 连续的标点（「！！」「……」「。”」）一起带走
          let j = i + 1;
          while (j < chars.length && (END.test(chars[j]) || /[”"’'）)】」』]/.test(chars[j]))) j++;
          // 标点一直延续到缓冲末尾：后面可能还有「！」「”」，等下一段增量再切（结束时 flush 兜底）
          if (j === chars.length) break;
          const s = chars.slice(0, j).join("").trim();
          if (Array.from(s.replace(/[\s\p{P}]/gu, "")).length >= MIN_CHARS) { cut = j; break; }
          i = j - 1;
        }
      }
      if (cut < 0 && chars.length > MAX_CHARS) {
        for (let i = chars.length - 1; i >= 8; i--) if (SOFT.test(chars[i])) { cut = i + 1; break; }
      }
      // 第一句：够长了就在最靠前的逗号处切（逗号后面还得有字，免得把「好的，」这种半句单独念）
      if (cut < 0 && this.o.eagerFirst && !this.emitted && !out.length && chars.length > FIRST_MAX_CHARS) {
        for (let i = 5; i < chars.length - 1; i++) if (SOFT.test(chars[i])) { cut = i + 1; break; }
      }
      if (cut < 0) break;
      const s = chars.slice(0, cut).join("").trim();
      this.buf = chars.slice(cut).join("");
      if (s) out.push(s);
    }
    this.emitted += out.length;
    return out;
  }

  /** 缓冲里还有没切出去的字 */
  get pending() { return this.buf.trim().length > 0; }

  /** 生成结束：剩下的都算最后一句 */
  flush(): string[] {
    const s = this.buf.trim();
    this.buf = "";
    return s && s.replace(/[\s\p{P}]/gu, "") ? [s] : [];
  }
}

/** 从标准 44 字节头的 WAV 里取出 PCM（找 data 块，防非标准头） */
export function wavPcm(wav: Buffer): Buffer {
  let off = 12;
  while (off + 8 <= wav.length) {
    const id = wav.toString("ascii", off, off + 4);
    const size = wav.readUInt32LE(off + 4);
    if (id === "data") return wav.subarray(off + 8, Math.min(wav.length, off + 8 + size));
    off += 8 + size + (size & 1);
  }
  return wav.subarray(44);
}
