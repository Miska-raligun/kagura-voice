// 图片：RGB565 裸帧 → JPEG（拍照与直播共用）。
import jpeg from "jpeg-js";

/** 字节数 → 分辨率。设备端 _CAM_SIZES 要与这张表保持一致。 */
export const RGB565_SIZES = new Map<number, [number, number]>([
  [160, 120], [176, 144], [240, 176], [240, 240], [320, 240], [480, 320], [640, 480], [800, 600],
].map(([w, h]) => [w * h * 2, [w, h]]));

/** 分辨率靠字节数反查，对不上返回 null。像素按大端读取、整数除法换算，与 Python 版逐像素一致。 */
export function rgb565ToJpeg(raw: Buffer, quality = 85): Buffer | null {
  const size = RGB565_SIZES.get(raw.length);
  if (!size) return null;
  const [w, h] = size;
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const v = raw.readUInt16BE(i * 2);
    rgba[i * 4] = Math.floor(((v >> 11) & 0x1f) * 255 / 31);
    rgba[i * 4 + 1] = Math.floor(((v >> 5) & 0x3f) * 255 / 63);
    rgba[i * 4 + 2] = Math.floor((v & 0x1f) * 255 / 31);
    rgba[i * 4 + 3] = 255;
  }
  return Buffer.from(jpeg.encode({ data: rgba, width: w, height: h }, quality).data);
}

export const isJpeg = (b: Buffer) => b.length >= 4 && b[0] === 0xff && b[1] === 0xd8;

/** 宽松 base64 解码：去换行、补齐 =。非法字符返回 null（对应 b64decode 抛异常）。 */
export function b64decodeLoose(s: string): Buffer | null {
  let c = s.replace(/[\r\n]/g, "");
  if (c.length % 4) c += "=".repeat(4 - (c.length % 4));
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(c)) return null;
  return Buffer.from(c, "base64");
}
