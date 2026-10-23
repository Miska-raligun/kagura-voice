// 边生成边播（§6.10）：把模型逐字吐出的文本切成句子，每句单独合成语音。
// 句末标点处切；一直不出句号的长句在逗号处切（不让第一声等太久）；太碎的不单独合成。

const END = /[。！？!?；;…\n]/;
const SOFT = /[，,、：:]/;
const MAX_CHARS = 48;       // 超过这么长还没句号，就在最后一个逗号处先切一刀
const MIN_CHARS = 2;        // 「嗯。」这种太短的并进下一句

export class SentenceSplitter {
  private buf = "";

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
      if (cut < 0) break;
      const s = chars.slice(0, cut).join("").trim();
      this.buf = chars.slice(cut).join("");
      if (s) out.push(s);
    }
    return out;
  }

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
