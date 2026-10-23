import { describe, it, expect } from "vitest";
import { SentenceSplitter, wavPcm } from "../src/speech/sentences.ts";
import { wavHeader } from "../src/util/wav.ts";

const feed = (parts: string[]) => {
  const s = new SentenceSplitter();
  const out: string[] = [];
  for (const p of parts) out.push(...s.push(p));
  return [...out, ...s.flush()];
};

describe("句子切分", () => {
  it("逐字喂入：句末标点处切，连续标点和引号一起带走", () => {
    expect(feed(Array.from("你好呀！今天天气不错。“真的吗？！”我问。"))).toEqual(["你好呀！", "今天天气不错。", "“真的吗？！”", "我问。"]);
  });
  it("太短的并进下一句；结尾没有标点也算一句", () => {
    expect(feed(["嗯。好的", "，我去看看"])).toEqual(["嗯。好的，我去看看"]);
  });
  it("很长不出句号：在逗号处先切", () => {
    const long = "这是一段很长很长的话，" + "没有句号一直说下去".repeat(5) + "，最后";
    const out = feed([long]);
    expect(out.length).toBeGreaterThan(1);
    expect(out.join("")).toBe(long);
  });
  it("英文句号后要有空格才算句末（小数点不切）", () => {
    expect(feed(["温度是 25.5 度。Hello world. OK"])).toEqual(["温度是 25.5 度。", "Hello world. OK"]);
  });
  it("wavPcm 取 data 块", () => {
    const pcm = Buffer.from([1, 2, 3, 4]);
    expect(wavPcm(Buffer.concat([wavHeader(4), pcm]))).toEqual(pcm);
  });
});
