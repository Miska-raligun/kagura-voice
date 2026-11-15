// 打印机机内摄像头拍一张（printer_snapshot，2026-11，主人「能让 agent 调用该摄像头拍照看打印的成品吗」）。
// P2S / X1 / H2 这代的摄像头在局域网里是 RTSPS（端口 322，用户名 bblp、密码 = 访问码，地址 /streaming/live/1），H.264 视频；
// P1 / A1 那代是端口 6000 的 JPEG 流（这里没做）。要成一张图得解码 H.264——组件零依赖、自己写解码器不现实，所以借用这台电脑上的 ffmpeg 取一帧。
// 别改坏的点：① 访问码在地址里，ffmpeg 报错里会带出来——给她 / 打日志前一律 `redact`；② 打印机的证书是自签的，ffmpeg 8 起默认校验证书
// （报 Peer certificate failed verification，LRN 2026-11-15 真机：老版 6.1 能拍、winget 装的 9.0 不能），所以带 `-tls_verify 0`；
// 关掉之后冒充的机器也能骗到访问码，所以拍之前先自己连一下摄像头端口、核对证书指纹（`checkCameraCert`，同 MQTT / FTPS 那条规矩）；③ 打印机可能要打开「局域网模式直播（LAN Only Liveview）」才给流，拍不到时先提这个；④ 只留最近 `KEEP` 张。
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

export const KEEP = 50;

/** 找 ffmpeg：BAMBU_FFMPEG → PATH → winget / 常见安装位置；找不到返回空 */
export function findFfmpeg(env: Record<string, string | undefined>, platform = process.platform, exists: (p: string) => boolean = fs.existsSync, readdir: (d: string) => string[] = (d) => fs.readdirSync(d)): string {
  const given = String(env.BAMBU_FFMPEG ?? "").trim();
  if (given) return given;
  const exe = platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  for (const d of String(env.PATH ?? env.Path ?? "").split(platform === "win32" ? ";" : ":")) if (d && exists(path.join(d, exe))) return path.join(d, exe);
  const c: string[] = [];
  if (platform === "win32") {
    const local = env.LOCALAPPDATA || "";
    if (local) {
      c.push(path.join(local, "Microsoft", "WinGet", "Links", exe));
      // winget 装的 Gyan.FFmpeg：Packages\Gyan.FFmpeg_…\ffmpeg-<版本>-full_build\bin\ffmpeg.exe（新开的终端才有 PATH，Kagura 可能是装之前起的）
      const pk = path.join(local, "Microsoft", "WinGet", "Packages");
      try {
        for (const p of readdir(pk).filter((n) => /ffmpeg/i.test(n))) {
          try { for (const v of readdir(path.join(pk, p))) c.push(path.join(pk, p, v, "bin", exe)); } catch { /* 不是目录 */ }
        }
      } catch { /* 没用过 winget */ }
    }
    c.push("C:\\ffmpeg\\bin\\ffmpeg.exe", path.join(env.ProgramFiles || "C:\\Program Files", "ffmpeg", "bin", exe));
  } else c.push("/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg");
  return c.find((p) => exists(p)) ?? "";
}

export const CAMERA_PORT = 322;
export const cameraUrl = (host: string, code: string, port = CAMERA_PORT) => `rtsps://bblp:${encodeURIComponent(code)}@${host}:${port}/streaming/live/1`;

/** 拍之前核对摄像头端口的证书（交出访问码之前）。known = MQTT 那边记下的指纹；camera = 以前在摄像头端口记下的（和 MQTT 不是同一张证书时才有）。
 *  返回 ok / 要记下的新指纹（第一次见）/ 不一样（不拍） */
export function cameraCertVerdict(fp: string, known: string, camera: string): "ok" | "remember" | "mismatch" {
  if (!fp) return "mismatch";
  if (fp === known || fp === camera) return "ok";
  return camera ? "mismatch" : "remember";
}
/** 把访问码从文字里抹掉（ffmpeg 的报错会带上地址） */
export const redact = (s: string, code: string) => (code ? s.split(code).join("***").split(encodeURIComponent(code)).join("***") : s);

/** 取一帧存成 JPEG（宽 1280，够看清又不费额度）。失败抛错，错误信息是给人看的、已抹掉访问码 */
export async function snapshot(o: { ffmpeg: string; host: string; code: string; out: string; port?: number; timeoutMs?: number }): Promise<void> {
  // -tls_verify 0：打印机证书自签，新版 ffmpeg 默认校验会失败；证书已经在 checkCameraCert 里按指纹核对过
  const args = ["-hide_banner", "-loglevel", "error", "-tls_verify", "0", "-rtsp_transport", "tcp", "-i", cameraUrl(o.host, o.code, o.port), "-frames:v", "1", "-vf", "scale='min(1280,iw)':-2", "-q:v", "3", "-y", o.out];
  fs.rmSync(o.out, { force: true });          // 同一秒拍两次文件名一样：先删掉，不然没拍到也会被当成拍到了（看到的是上一张）
  const r = await new Promise<{ code: number | null; err: string; timedOut: boolean }>((resolve) => {
    let err = "", timedOut = false;
    const child = spawn(o.ffmpeg, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    child.stderr.on("data", (d: Buffer) => { err = (err + d.toString("utf8")).slice(-4000); });
    const t = setTimeout(() => { timedOut = true; child.kill(); }, o.timeoutMs ?? 25_000);
    child.once("error", (e) => { clearTimeout(t); resolve({ code: null, err: e.message, timedOut }); });
    child.once("close", (code) => { clearTimeout(t); resolve({ code, err, timedOut }); });
  });
  const ok = fs.existsSync(o.out) && fs.statSync(o.out).size > 0;
  if (ok && !r.timedOut) return;
  fs.rmSync(o.out, { force: true });
  const tail = redact(r.err.trim().split(/\r?\n/).filter(Boolean).slice(-3).join("\n"), o.code);
  const hint = "打印机上可能要打开「局域网模式直播」（LAN Only Liveview，在网络设置里）；打印机正在被别的软件（Bambu Studio、Handy）看直播时也可能拒绝";
  if (r.timedOut) throw new Error(`拍照超时（${Math.round((o.timeoutMs ?? 25_000) / 1000)} 秒没拿到画面）。${hint}`);
  if (/401|Unauthorized/i.test(tail)) throw new Error(`摄像头拒绝登录（访问码不对？）${tail ? `：${tail}` : ""}`);
  throw new Error(`没拍到${tail ? `（${tail}）` : ""}。${hint}`);
}

/** 拍一张存进 dir（只留最近 KEEP 张），返回文件路径 */
export async function takeSnapshot(o: { ffmpeg: string; host: string; code: string; dir: string; name: string; port?: number; timeoutMs?: number; now?: Date }): Promise<string> {
  fs.mkdirSync(o.dir, { recursive: true });
  const d = o.now ?? new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}-${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}${String(d.getSeconds()).padStart(2, "0")}`;
  const out = path.join(o.dir, `${o.name.replace(/[^\p{L}\p{N}_-]+/gu, "_") || "printer"}-${stamp}.jpg`);
  await snapshot({ ...o, out });
  const old = fs.readdirSync(o.dir).filter((f) => f.endsWith(".jpg")).map((f) => ({ f, t: fs.statSync(path.join(o.dir, f)).mtimeMs })).sort((a, b) => b.t - a.t).slice(KEEP);
  for (const x of old) fs.rmSync(path.join(o.dir, x.f), { force: true });
  return out;
}

