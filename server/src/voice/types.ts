// 语音服务接口：百度实现（baidu.ts）与契约测试的假实现（fake.ts）都满足它。
/** 用谁的声音说：per = 百度音色编号；provider + voice = 指定服务商和它的音色（见 voice/hub.ts） */
export interface VoiceRef { per?: number; provider?: string; voice?: string }

export interface SynthOpts { fixed?: boolean }

export interface Voice {
  /** WAV → 文本；识别不出来返回空串 */
  transcribe(wav: Buffer): Promise<string>;
  /** 文本 → WAV 文件路径（已去 markdown；空文本返回 null）。
   *  fixed：固定的话（切角色问候、没听清……）合成一次就常驻，不被普通缓存的上限挤掉 */
  synthesize(text: string, v?: number | VoiceRef, opts?: SynthOpts): Promise<string | null>;
}
