// WAV 工具：头部、测试音、录音电平统计。

export const SAMPLE_RATE = 16000;

export function wavHeader(dataLen: number, sr = SAMPLE_RATE, ch = 1, bits = 16): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(36 + dataLen, 4);
  h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(ch, 22);
  h.writeUInt32LE(sr, 24);
  h.writeUInt32LE(sr * ch * bits / 8, 28);
  h.writeUInt16LE(ch * bits / 8, 32);
  h.writeUInt16LE(bits, 34);
  h.write("data", 36, "ascii");
  h.writeUInt32LE(dataLen, 40);
  return h;
}

/** 1 秒 440Hz 正弦波（/test-tone），与 Python 版逐样本一致 */
export function testTone(): Buffer {
  const sr = 16000, n = sr;
  const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) pcm.writeInt16LE(Math.trunc(16000 * Math.sin(2 * Math.PI * 440 * i / sr)), i * 2);
  return Buffer.concat([wavHeader(pcm.length, sr), pcm]);
}

export interface AudioStats { dur: number; rms: number; peak: number; clip_pct: number; dc: number }

/** 粗看一条 16bit 单声道 WAV 的电平（对应 _audio_stats）。不是 WAV 返回 null。 */
export function audioStats(wav: Buffer): AudioStats | null {
  if (wav.length < 46 || wav.subarray(0, 4).toString("ascii") !== "RIFF") return null;
  const n = Math.floor((wav.length - 44) / 2);
  if (n === 0) return null;
  let s = 0, s2 = 0, mn = 0, mx = 0, clip = 0;
  for (let i = 0; i < n; i++) {
    const v = wav.readInt16LE(44 + i * 2);
    s += v; s2 += v * v;
    if (v < mn) mn = v;
    if (v > mx) mx = v;
    if (v >= 32000 || v <= -32000) clip++;
  }
  const mean = s / n;
  const v = Math.max(0, s2 / n - mean * mean);
  return {
    dur: Math.round(n / SAMPLE_RATE * 100) / 100,
    rms: Math.trunc(Math.sqrt(v)),
    peak: Math.max(Math.abs(mn), Math.abs(mx)),
    clip_pct: Math.round(clip * 100 / n * 100) / 100,
    dc: Math.trunc(mean),
  };
}
