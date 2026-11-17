# 直播与摄像头

> 踩坑记录（LRN），从 CLAUDE.md 按子系统拆出来的。改直播推流、监控页画面、拍照取帧之前先读这份；新踩的坑也记在这里（写清症状、原因、别改坏的点）。

- **直播链路**：MQTT 下发 `stream_start` → 设备连 TCP :5002 → 每帧 `4 字节大端长度
  + RGB565 裸字节`（0 长度=结束）→ 服务端只留最新一帧 → 网页长轮询
  `/stream/<dev>/frame.jpg?after=<seq>`。三个别踩的点：
  ① 握手行和第一帧会被 TCP 合并进同一个 segment，必须用 `_Reader` 的缓冲接着读，
  丢掉剩余字节会让整条流错位；② 网页每 20s 续期、设备端 45s 超时收摊，
  这是「关掉网页摄像头别一直开着」的唯一保障，改续期周期要同步改 `_STREAM_RENEW_SECS`；
  ③ 直播中按快门默认走 `_capture_from_stream`（取服务端最新帧，瞬时但只有
  160×120）；带 `hires=true` 才发 MQTT capture，由 `_stream_hires_capture`
  在推流循环里临时切回 QVGA 拍一张（画面停几秒）。**capture 命令必须在
  `_stream_drain_cmds` 里就地消费**——压回队列就要等直播结束才执行，
  用户按下快门就成了「没反应」。插拍耗时要补回 `_stream_deadline`，
  且 `stream_server.SOCKET_TIMEOUT` 必须大于插拍总耗时（现 45s），
  否则正常插拍会被当成掉线断开。
- **推流必须复制帧**：`raw = bytes(raw)` 那行别删。发一帧 38KB 期间驱动可能往
  同一块 framebuffer 写下一帧，取景模式定格处有同样的复制与注释。
- **网页画面「频闪」查过一次，不在设备端**：实测 226 帧亮度 120.5±0.3、连续帧
  无撕裂——设备送出的帧是干净的。真凶是 `setStage()` 把还没解码的 `<img>`
  换上屏。**必须 `await next.decode()` 之后再换 src，并复用同一个 `<img>`**；
  改回「新建 img → appendChild → 删旧 img」就会重现。
- **直播分辨率**：`_cam_set_framesize` 切 QQVGA，退出时切回 QVGA。固件没有
  `camera.deinit()` 就返回 False 照常推流（只是慢），别把这条回退路径删掉。
- **摄像头固件差异**：抓帧走 `_cam_grab()`（优先 `camera.capture()`→bytes，
  回退 `camera.snapshot()`→`image.Image`），预览走 `_cam_show()`（优先
  `Lcd.drawRawBuf`，回退 `Lcd.show`，探测一次后固定）。帧是 raw RGB565，
  分辨率靠字节数反查 `_CAM_SIZES`——改这张表要同步服务端 `RGB565_SIZES`。
