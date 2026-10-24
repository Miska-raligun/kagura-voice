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

/**
 * 响度补偿（16 位单声道 PCM）：只看有声段（20ms 一帧、比 -40dBFS 响的帧）的平均能量，比目标小就放大，
 * 最多 ×4（+12dB），且放大后峰值不超过 0.9 满幅（不削波）。本来够响的不动（不压低）。
 * 为什么：别家合成——尤其 MiniMax 复刻音色——常比百度小一截（复刻会把原始录音的音量一起学过去），设备上听着「声音好小」。
 */
export const LOUDNESS_TARGET_RMS = 0.12;   // 约 -18dBFS，和百度合成的说话音量差不多
export function normalizeLoudness(pcm: Buffer, target = LOUDNESS_TARGET_RMS, maxGain = 4): Buffer {
  const n = Math.floor(pcm.length / 2);
  if (n < 320) return pcm;
  let peak = 0, voicedSum = 0, voicedN = 0;
  for (let f = 0; f + 320 <= n; f += 320) {
    let e = 0;
    for (let i = f; i < f + 320; i++) {
      const v = pcm.readInt16LE(i * 2) / 32768;
      e += v * v;
      const a = Math.abs(v);
      if (a > peak) peak = a;
    }
    if (e / 320 > 1e-4) { voicedSum += e; voicedN += 320; }   // 1e-4 = (0.01)² ≈ -40dBFS
  }
  if (!voicedN || !peak) return pcm;
  const rms = Math.sqrt(voicedSum / voicedN);
  const gain = Math.min(target / rms, maxGain, 0.9 / peak);
  if (gain < 1.12) return pcm;                                  // 不到 1dB 的差别不折腾
  const out = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(pcm.readInt16LE(i * 2) * gain))), i * 2);
  return out;
}
