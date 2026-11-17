# 设备可靠性：看门狗、自愈、文件同步

> 踩坑记录（LRN），从 CLAUDE.md 按子系统拆出来的。改看门狗、网络自愈、崩溃日志、设备文件同步（OTA），或新写设备端长循环之前先读这份；新踩的坑也记在这里（写清症状、原因、别改坏的点）。

- **看门狗**：`WATCHDOG_TIMEOUT_MS=180s` 必须大于最长合法阻塞。
  长循环里要 `hw._wdt_feed()`。ESP32 WDT 创建后无法关闭。
  **"最长合法阻塞"里包含整段播放**，不只是 HTTP 30s——早报推送 74 秒，
  加上下载与写盘就顶到了原来的 120s 窗口（见下条）。
- **`global` 声明必须有主**（LRN 2026-08-25）：`netsvc.mqtt_check` 里写过
  `global _mqtt_ok`，但本模块从来没有这个名字（状态在 `diag`）。后果是
  **任何一次 MQTT 掉线都变成 NameError 逃出 `mqtt_check`**，主循环连吃 10 次
  就 `machine.reset()`——同样表现为"毫无征兆黑屏重启"，crash_reports 里
  4 份日志全是它。`global X` 会让静态检查把 X 当成已定义，所以
  `tools/check_split.py` 第 5 项专门查这个：被 global 声明却无人赋值 = 报错。
- **崩溃日志取尾不取头**：`crash.log` 是追加的，死因永远在末尾，
  `_boot_report` 却只上传前 8KB——2026-08-11 那份 8KB 日志里一行堆栈都没有，
  全是几天前的 `power-change`。满电涓流会让 `isCharging()` 每几十秒翻一次，
  条条持久化就是拿噪声把证据挤出去，现在只有"电量没满却停充"才写 flash。
- **"设备僵死但没复位"的排查判据**（LRN 2026-08-26，那次停摆 4 小时 51 分，
  从完全空闲的状态僵住，全靠手动上电才回来）：
  ① `crash.log` 里**有没有 `netfix1`**——失联满 10 分钟必写一条，没有就说明
  `net_watch_tick` 压根没执行到，即主循环停摆（不是网络问题）；
  ② 有没有堆栈 = 有没有未捕获异常；③ 崩溃日志的时间跨度能证明中间**有没有
  重启过**（重启会上传并删除它）。三条都空 = 主循环卡死且看门狗没救它。
- **看门狗武装失败必须回退，而且必须能被远程看见**：`_wdt_init` 旧实现构造
  失败只 print 一行就把 `_wdt` 留成 `None`——整台设备失去硬件自愈能力，
  远程完全看不出来。现在依次试 `WATCHDOG_TIMEOUT_MS` 和 120000（8 月上旬
  真机产生过"看门狗复位"的已知可用值），结果记进 `hw._wdt_ms` 随心跳上报，
  服务端日志与 `/device-status` 直接显示 `wdt=180s` / `wdt=⚠️未武装`。
  **改 `WATCHDOG_TIMEOUT_MS` 之后务必看一眼心跳里的 wdt**——固件对上限
  有没有自己的限制无从预知，改大了却被拒 = 悄悄卸掉了看门狗。
- **死人开关（`hw._deadman_check`，判据放在喂狗点上）**：失联超过
  `DEADMAN_SECS`（30 分钟，故意大于 netfix2 的 25 分钟，主循环还活着时优先
  走正常分级自愈）就自己复位，复位前往 `crash.log` 写一行
  `deadman (stuck at <阶段>, dead=<秒>)`。**为什么判据在 `_wdt_feed()` 里**：
  8/26 那次僵死，看门狗武装着 180 秒却一次没响——卡住的循环一边转一边喂狗，
  而 netfix1/netfix2 都要主循环跑到 `net_watch_tick` 才有机会执行，三道自愈
  全都够不着。`_wdt_feed()` 是唯一一个在每个这种循环里都还在转的函数，
  判据放这儿，以后新写的"喂狗死循环"也自动被兜住。两个实现要点：
  ① 必须用 `ticks_ms` 而非 `time.time()`——`clock.sync_rtc()` 会把墙钟往前跳
  好几年，拿墙钟算年龄一开机就判超时；② 开机门槛用**一次性闩锁**
  （`_deadman_armed`），不是每次比对开机时刻——`ticks_diff` 只在约 6.2 天内
  有效，连续跑一周后拿它算 uptime 会翻负，兜底就悄悄失效了。
  阶段标记 `cfg.St.stage` 由主循环每轮复位成 `loop`，各长循环入口自己改写
  （`rec`/`dl`/`play`/`cam`/`stream`/`chat`）——卡住时主循环轮不到复位，
  标记正好停在卡住的那一段上。
- **纯硬件条件的等待一律要有上限并喂狗**：`drain_touch()` 曾是
  `while M5.Touch.getCount() > 0` 死等且一次不喂狗——屏上压个东西、驱动漏报
  一次抬手，就是"主循环停摆 + 看门狗饿不死它"的配方。写这类循环前先问一句
  "硬件永远不给我想要的状态会怎样"。
- **网络自愈的判据只看 `dead_for`（多久没成功联系上服务端），绝不能加
  `wifi_ok` / `_mqtt_ok` 前置条件**。曾经加过，结果 2026-08-21 那次失联
  79 分钟自愈一次都没触发：WiFi 驱动 wedge 的典型表现就是 `isconnected()`
  仍返回 True、MQTT socket 也还在，设备自认为健康，可包一个都出不去
  （服务端记的正是 `mqtt=True`）。**"自己看起来好不好"不可信，
  "服务端还认不认得我"才是唯一可信的判据。**
  看门狗也救不了这种情况——主循环活得好好的，一直在喂狗。
- **设备文件同步（`ota.py`，管理界面「设备 → 图片与代码」）**：服务端 `server/src/devicefiles.ts` 存
  `<数据目录>/device_files/`（自定义）+ 构建时打进来的 `device/src`（`virtual:device-fw`，版本 = 服务端版本）；
  MQTT `{"action":"sync","scope":"res|code|all"}` → 设备空闲时 `GET /device/files` 拿清单（路径/大小/sha256）
  → 只下变了的 → `POST /device/sync-result` 回报；指纹 `rev` 随心跳 `fw`/`res`/`fwv` 上报。别改坏的点：
  ① 路径白名单两边一致（`src/<名>.py`、`resource/[角色/]<名>.jpg`），`main.py` **故意不能在线更新**——它坏了只能接 USB；
  ② 代码**先全部下载校验成 .new，屏幕确认后**才先写 `data/ota_pending.json` 再换文件（顺序反了中途断电就回滚不了）；
  ③ 回滚在 `device/main.py` 的 `_ota_guard`：起不来或第 4 次开机标记还在就从 `src.bak/` 换回，`ota.tick()` 等心跳成功一次
  才删标记——别提前到 `setup()` 结束，那时还不知道新代码能不能跟服务端说上话；
  ④ `ota_state.json` 只记自己装过的文件，删除只删这些（手动传的文件不碰）；换了图要清 `ui._role_hit`/`_img_missing`；
  ⑤ `rev` 算法两边必须一致（`DeviceFiles.rev` ↔ `ota._rev`），`import_sim` 里专门对过。
  ⑥ **反方向：从设备取回图片**（LRN 2026-10-30，症状「图当初用 File Manager 直接传到设备上，服务端没有，手机页面 / 头像没图、原图也找不到了」）：
  管理界面按钮 → `POST /api/admin/device-files/pull` → MQTT `{"action":"upload_res"}` → 设备空闲时 `ota.upload_res()` 把 flash 上 `resource/[角色/]*.jpg` 逐张
  `POST /device/upload-res` → 最后 `sync-result` 报 `scope: "upload"`。服务端只在点了之后 10 分钟内、受信设备、JPEG、`resource/` 下才收，**已有的不覆盖**（409）；
  设备心跳 `pull: 1` 才显示按钮（旧代码先「更新设备代码」）。
- **回退开关**（设备端顶部常量）：`BARGE_IN`、`WAKE_MIC_PERSISTENT`、`WATCHDOG_ENABLED`、
  `SHOW_CHAT_TEXT`、`VISUAL_ENABLED`、`USE_STATE_IMAGES`、`CAMERA_MODE_ENABLED`、
  `CAMERA_QVGA`、`PREVIEW_SWAP`、`MIC_GAPLESS`、`PLAY_STREAMING`、
  `HANDS_FREE_TH_RATIO`（改 1.0 = 免手模式不加门槛）、`STREAM_ENABLED`、`STREAM_QQVGA`、
  `TOUCH_FEEL_ENABLED`（整个触觉）、`FEEL_NOTIFY_ENABLED`（只关"主动开口"，
  保留反射层和体感层）、`FEEL_WAKE_ON_PICKUP`
  ——真机出问题先关开关再排查。
