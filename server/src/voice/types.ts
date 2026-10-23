// 语音服务接口：百度实现（baidu.ts）与契约测试的假实现（fake.ts）都满足它。
export interface Voice {
  /** WAV → 文本；识别不出来返回空串 */
  transcribe(wav: Buffer): Promise<string>;
  /** 文本 → WAV 文件路径（已去 markdown；空文本返回 null） */
  synthesize(text: string, per?: number): Promise<string | null>;
}
