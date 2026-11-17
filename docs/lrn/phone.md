# 手机 / 平板客户端

> 踩坑记录（LRN），从 CLAUDE.md 按子系统拆出来的。改 web/app.html、配对、SSE 推送、手机图片之前先读这份；新踩的坑也记在这里（写清症状、原因、别改坏的点）。

- **手机 / 平板客户端（`web/app.html` = `/app`，`server/src/clients.ts`、`routes/client.ts`，LRN 2026-10-24）**：手机是和 CoreS3 并列的一台设备
  （设备 id `phone-xxxxxx`），对话走同一套 `/chat` / `/chat-vision` / 异步长轮询，「看家」页用监控接口远程看 CoreS3。三个别改坏的点：
  ① **鉴权靠配对令牌**（管理界面扫码发，`clients.json` 只存哈希）：`ctx.deviceTrusted` 里令牌判据放在 Origin 判据**之前**（手机是浏览器），
  且令牌只给它自己的 id 受信（不能拿手机令牌冒充 CoreS3）；`ctx.tokenOk` 也认令牌（看家页要用监控接口，`<img>` 设不了头所以收 `?ct=`）；
  ② **推送走 SSE**（`/client/events`）：浏览器连不了 MQTT，`MqttHub.taps` 把每条发布抄给 `Clients.onPublish`，`kagura/push|cmd/<手机 id>` 转过去——
  新加发给设备的命令照常 `mqtt.publish` 就行，手机自动收到。**出口选设备**（`Outbox.target`）：在线 = 心跳没断的设备 + SSE 连着的手机
  （页面离开前台就主动断开，iOS 后台连接会挂着却收不到）；推给绑定说话角色的设备，同样合适时家里的优先（在家不两边一起响）；
  手机 `portable`，不受「不在家不播」限制（不在家时主动说的话去开着的手机），但不收 mirror / relay；
  ③ `/chat-vision` 纯文字只对配对过的手机放行（设备那边「wav 或 image 必须有一个」是新旧两版共用的契约）。
  浏览器只在 HTTPS 下让网页录音（`getUserMedia`）：局域网 http 下打字、听回复（Web Audio 不受限）、SSE 推送、拍照（`<input capture>` 走系统相机）、
  看家都正常，只有「按住说话」不行——README 推荐 Tailscale `tailscale serve`。
  **iOS 声音**（症状「看到回复、浏览器有小喇叭，手机却没声」）：iOS 的 Web Audio 默认是「环境音」，侧面静音开关一开就静音。
  `unlockAudio()` 在点击 / 抬手里设 `navigator.audioSession.type = "playback"`（iOS 17+）并用 `<audio>` 播一小段静音（老 iOS 靠它切到媒体播放类别）；
  `Player.feed` 先把 16k 重采样到 `AudioContext.sampleRate` 再建 buffer（iOS Safari 对 16k AudioBuffer 挑剔）。别删这两处。
  **声音被系统暂停**（LRN 2026-10-24，症状「发图片加一句话后一直『她在说…』，看得到几个字、没声音」）：去拍照 / 选相册时页面进了后台，
  iOS 把 AudioContext 暂停（suspended / interrupted）；回来用键盘「发送」键发出去，一次都没点屏幕，没人恢复它。暂停时播放时钟不走，
  `Player.drain()` 以前就永远等。现在：解锁也认 `keydown`；`pageshow` / `focus` / 选完照片先试 `resume()`；`drain()` 里恢复不了就亮状态条上的
  「▶ 点我播放」（点它就是那次手势），两分钟没人点就放弃。**新加任何「等播放时钟」的循环都要考虑时钟不走的情况。**
  管理界面里手机和 CoreS3 在同一张设备表（`/api/admin/devices` 带 `kind: "phone"`），配对入口是表上的「＋ 添加手机」。
  舞台图跟着状态换，规则抄设备端 `ui._IMG_MAP`（待机 img_bg / 录音 img_recording / 思考 img_streaming / 说话 img_playing，角色目录优先、缺了退 img_bg）——
  改设备端的映射要同步改 `app.html` 的 `IMG_MAP`；图预先解码好、复用同一个 `<img>` 换 src。
  **手机有自己的一套图**（界面上别写「CoreS3」，硬件设备不止这一种，统称「硬件设备」；也别加大段说明小字）（`server/src/appimages.ts`，`<数据目录>/app_images/[角色/]<图名>.<jpg|png|webp>`，LRN 2026-10-26）：CoreS3 那套受设备内存所限是 320×240 JPEG，
  手机屏幕大、竖着拿，两套分开存，手机这套不裁、不限比例、单张 4MB。手机只请求 `GET /app/img?role=&name=`，**挑图在服务端 `resolve`**：
  先角色的、再默认的（角色对不上比画质差更糟）；同一层手机的优先；手机这套缺了某个状态用手机这套的待机图（别和 320×240 的混着闪）；再退 CoreS3 那套。
  改这个顺序要同步管理界面 `PhoneImages.fallback`。入口：手机右上角「形象」（`/client/images`，配对令牌）、管理界面「设备 → 图片与代码」切到「手机 / 平板」。
  任一套图变了都经 SSE 发 `{"action":"images"}`，开着的页面清 `imgCache` 重取；舞台高度跟着待机图比例走（`applyRatio`，竖图最多 54vh）。
  聊天里的相机键是「拍照 / 从相册选」底部菜单（`chooseImage`），她说「我看看」那条只开相机。导出项「device」含 app_images。
  布局：清晰的角色图按 4:3 放顶上（`--stage-h`），聊天从它下面开始（`.stagegap`）、不压着她；底色是同一张待机图放大糊开压暗（`#bgAmb`），颜色跟着角色走，别再写死成某个色调。
  **摇一摇**同 CoreS3 彩蛋：`devicemotion` 去重力后 700ms 内 3 下 → 换 `img_shake`、`GET /shake`，回复走推送（推给手机的通知带 `text`，页面显示成她的一条消息）。
  动作传感器只在 https 下有；iOS / 新版 Chrome 要在一次点击里 `DeviceMotionEvent.requestPermission()`——挂在 `unlockAudio` 上，**`pointerdown` 里申请不算数**。
- **手机通知（Web Push，`server/src/webpush.ts`、`/app/sw.js`、`Outbox` 的 `notify`，2026-11）**：页面关着 SSE 就断了，那时她主动说的话以前谁都收不到。现在出口**没有能播的设备**时（不在家且页面没开 / 一台在线的都没有）
  给开了通知的手机发一条系统通知（标题 = 说话的 agent，正文截 300 字）；顺带朗读（mirror）和传话（relay）不发；`voice_push: never` 也不发。页面开着的手机不发通知（SSE 那边已经在播）。
  实现：VAPID（ES256 的 JWT）+ aes128gcm（RFC 8291），只用 Node 自带 crypto；测试拿 `http_ece`（web-push 包用的库，devDependency）解一遍对照。别改坏的点：
  ① service worker 在 `/app/sw.js`、页面是 `/app`：靠 `Service-Worker-Allowed: /app` 头 + 注册时 `scope: "/app"`，少一个就注册不上；② 订阅失效（404 / 410）就删；每台手机最多留 4 个订阅；
  ③ `webpush.json` 里有服务端私钥：不带密钥导出时整个不带（订阅绑着私钥，换台机器重新点「开启」）；④ 经代理发（`proxiedFetch`）——Chrome 的推送服务是 FCM，国内直连不上；
  ⑤ 浏览器只在 https 下给订阅，iOS 要先「添加到主屏幕」从图标打开；VAPID 的 `sub` 现在是占位的 `mailto:admin@example.com`。**没在真手机上验证过**（加密和签名对照过第三方库，推送服务那头的接受与否没法在测试里验）——Apple 那边若拒收（403 BadJwtToken），先怀疑 `sub`。
