# 自带 MCP 组件：打印机、Blender、build123d

> 踩坑记录（LRN），从 CLAUDE.md 按子系统拆出来的。改 server/src/printer、blender、cad 之前先读这份；新踩的坑也记在这里（写清症状、原因、别改坏的点）。

- **拓竹打印机 = 自带的 MCP 服务器（`server/src/printer/`，`kagura mcp bambu-printer`，2026-11）**：先是做成了核心模块（管理页 + 内置工具），主人说不该放进核心，改成这样——**别再搬回去**。
  拓竹的局域网接口 = TLS 上的 MQTT（8883，用户名 `bblp`、密码 = 访问码，订阅 `device/<序列号>/report`）。默认**只读**：只发一条 `pushall`（要完整状态）；
  不开「开发者模式」第三方发不了控制指令（拓竹的授权限制），控制类的见下面 `BAMBU_CONTROL`。
  **它是独立进程、不依赖 Kagura 核心**（核心只负责按 mcp.json 拉起它、转发通知），别的 MCP 客户端也能直接跑 `kagura mcp bambu-printer`——别往里加只有 Kagura 才有的依赖；状态目录 `BAMBU_STATE_DIR`（默认当前目录 `bambu_printer/`）。
  型号 `BAMBU_MODEL` 不填默认 `DEFAULT_MODEL`（P2S）。
  `mqttlite.ts` 最小 MQTT 客户端（不引 mqtt.js）；`bambu.ts` 连接 + 解析 + 事件；`mcp-server.ts` 是 MCP 这一层（一行一个 JSON-RPC，手写、零依赖）：配置走 env
  （`BAMBU_HOST` / `BAMBU_SERIAL` / `BAMBU_ACCESS_CODE` / `BAMBU_NAME` / `BAMBU_WARNINGS`；没填或还是模板的中文占位时服务器照样起来、工具说缺什么），
  工具 `printer_status`（`raw=true` 给原始数据）、`printer_retrust`，事件用 `notifications/message` 发出去（打完 notice，其余 warning），句子是 `eventText` 写的固定句式。
  别改坏的点：① 打印机推的是**增量**，`merge` 并进上一份（带 id 的数组按 id 并——AMS 料槽；`hms` 整份换）；`command` 不是 `push_status` 的是别的回执，不并；
  ② 状态变了**等 `settleMs` 再判断**（状态和原因常分两条来），判断时又变了就不发；刚连上时的状态、已有的告警不通知（`prev === undefined` / `hmsSeen === null`）；
  ③ 不通知的：取消（`FAILED` + `0300-400C`）、在打印机上手动暂停（`stg_cur` 16）；告警只在打印中发、同一个 30 分钟内不重复；
  ④ 证书是打印机自签的，没法按 CA 验：**第一次记指纹（`<数据目录>/bambu_printer/<序列号>.json`），以后不一样就不连、连 CONNECT 都不发**（别把访问码交给冒充的机器），发一条警告通知；
  主人确认后 `printer_retrust` 忘掉重记；换了 IP 当成换了机器；⑤ 访问码错（CONNACK 4 / 5）隔 5 分钟才重试，别猛连。
  ⑥ **连接最高只用 TLS 1.2**（`TLS_MAX`，MQTT 和 FTPS 都是；LRN 2026-11-14）：P2S 固件对 TLS 1.3 的握手不回应，一直挂到超时——rc.45 没限制，在 P2S 上根本连不上（ha-bambulab 里踩出来的，别去掉）。
  **控制（`control.ts`，env `BAMBU_CONTROL=1` 才有那三个工具）**：主人愿意开「仅局域网 + 开发者模式」之后加的。`printer_control`（pause / resume / stop / 灯 / 速度）、`printer_files`、`printer_print`。
  别改坏的点：ⓐ 发之前看状态里的 `devMode`（`fun` 的 0x20000000 位 = 指令要签名 = 没开开发者模式）——没开就不发、告诉主人怎么开；ⓑ 指令用 QoS 1 发、按 `sequence_id` 等回执（`BambuPrinter.command`），
  回执说失败 / 几秒没回执都照实说「不知道成没成，看状态」，**别说成功**；ⓒ `printer_print` 是两步：第一次只返回摘要 + 一次性确认码（绑着参数、10 分钟有效），带码同参数再调才上传并发 `project_file`——
  热床上有没有东西只有人看得到；正在打的时候不让开新的；ⓓ 只收**切好片**的 3mf（`zipNames` 看里面有没有 `Metadata/plate_N.gcode`），不做切片；ⓔ 文件走 FTPS（`ftps.ts`：990 端口隐式 TLS、数据通道复用控制通道的 TLS 会话、
  PASV 回复里的 IP 不用、上传完不等对方 TLS 收尾；登录前也验证书指纹；**数据通道先连 TCP、马上发 LIST / STOR，再等 TLS 握手**——打印机（vsftpd）收到命令才开始握手，先等握手再发命令会互等到「连接超时」，LRN 2026-11-15 真机症状；553 / 550 翻成「存储不让写，多半是存储卡」）；ⓕ P2 / H2 这代文件地址是 `ftp:///<名字>`，老机型是 `file:///sdcard/`（env `BAMBU_FILE_URL`）。
  **切片（`slice.ts` / `threemf.ts`，`printer_slice`，2026-11）**：调这台电脑上 Bambu Studio 的命令行（`--slice N --outputdir <dir>/ --export-3mf <名> <源>`，参数覆盖 `--key=value` 横线写法、优先级最高）。两条路：
  ① 项目里的 `printer_model`（`Metadata/project_settings.config`）就是这台（`BAMBU_MODEL`，`modelMatches`）→ 用文件自带配置、只覆盖指定的几项（最稳）；② 别的机型 / 普通 3MF / STL → `Profiles` 把系统配置的 `inherits` 链展开成完整配置
  （`from: "User"`、`inherits` = 自己的名字、`*_settings_id`；工艺 / 耗材里和机器重复的键去掉——社区的经验，命令行不认 inherits），`--load-settings 机器;工艺` + `--load-filaments` 每种料一份（同名换机型后缀 → 同材质 Generic）。实验性。
  别改坏的点：ⓐ **切完一律核对输出的机型**，不是这台就不交出去（别的机型的 G-code 会撞板）；`printer_print` 发之前也核对一遍；ⓑ 临时目录每次删掉（一次切片几百 MB）；一次只切一个；ⓒ 统计从 `Metadata/slice_info.config` 读（prediction 秒、weight 克、每种料 used_g），读不到就不说；
  ⓓ 多种料的文件发打印时必须给齐 `slots`，材质和槽里的对不上要提醒；
  ⓔ **Bambu Studio 窗口开着就别切**（`studioRunning`，LRN 2026-11-15，症状「同一个 3mf 昨天几秒切完，今天卡 9 分钟超时」）：它默认只许开一个，命令行再起一个时参数会转给开着的窗口，命令行这边干等到超时。切之前先查进程、开着就立刻说「关掉」；超时报错带最后的输出，Windows 上 `taskkill /T` 连子进程一起结束（残留进程会让下一次接着卡）；
  ⓕ 交给命令行的文件一律先**复制进临时目录、改英文名**（`input.3mf` / `input.stl` → `output.gcode.3mf`，切完再按原名存）——中文路径不一定认，也碰不到主人的源文件；**STL 先 `placeStl` 挪到打印板中间、底面贴 z=0**（中心取机器配置的 `printable_area`）：Blender / build123d 建的模型以原点为中心，拓竹的板原点在角上，不挪大半个在板外；
  ⓖ **展开配置要并 `include` 的模板**（LRN 2026-11-15，症状「P2S 一开始打就空走：不调平、不加热、挤不出料」）：P2S 这代的启动 / 结束 / 换料 / 换层 G-code 放在 `… template machine_start_gcode` 这类模板里、由 `include` 列表引用，不在 `inherits` 链上；以前只认 inherits，拿到的是 `fdm_machine_common` 里通用的老启动代码。每层先并 include 再并自己的键，模板缺了就报错；耗材配置也有 include；
  ⓗ **切完和发打印前都查结果本身**（`startProblem`，主人「怕哪个配置没写好导致设备出问题」）：① 启动代码（`startCheck`）：第一次挤料（E > 0）之前必须有喷嘴加热（M104 / M109 ≥ 150℃）和热床加热（M140 / M190）；
  ② 温度（`tempProblems`）：看文件里的 `project_settings.config`（不看 G-code——启动代码里有擦嘴的 140 / 170℃，会误报），这一盘用到的每种料喷嘴温度要在那种料的范围里（`NOZZLE_RANGE`），喷嘴 ≤ `MAX_NOZZLE`、所有 `*_plate_temp*` ≤ `MAX_BED`。
  拓竹官方给 P2S 的 63 种耗材配置跑过一遍零误报——改范围前同样跑一遍。不对就不交出去、不发，兜住以后别的原因拼错的配置。
  **打印板类型**（`PLATE_TYPES` / `plateValue`，env `BAMBU_PLATE`，不填按纹理 PEI；LRN 2026-11-15，症状「打印机报 0500-8051 打印板类型与切片设置不符」）：Bambu Studio 没指定时 `curr_bed_type` 默认 Cool Plate，P2S 会识别板子、对不上就停。
  切片一律带 `--curr-bed-type=<配置的板子>`（`plate_type` 参数可改）；开打前文件里的 `curr_bed_type` 和配置的不一样就不打；确认摘要里写清放哪块板。板子类型同时决定热床温度，别让她「忽略此问题」。
  **打印机上已有的文件也查**（LRN 2026-11-15，症状「没有任何检查、一开打就空转、温度不升」——打的是修复前切的、早就传上去的旧文件）：`printer_print` 给的是打印机上的文件名时先 `Ftps.download`（RETR）到临时文件、和本机文件走同一套检查，下载不回来就不打。命令行参数照官方 wiki + 社区整理，**没在真机上跑过**；测试用一个假的 `bambu-studio` 脚本（`test/slice.test.ts`）。
  **机内摄像头拍照（`printer_snapshot`，`camera.ts`，2026-11）**：P2S / X1 / H2 是 RTSPS（322 端口，`bblp` + 访问码，`/streaming/live/1`，H.264），P1 / A1 是 6000 端口 JPEG 流（没做）。
  组件零依赖、解不了 H.264，所以借这台电脑上的 ffmpeg 取一帧（`findFfmpeg`：`BAMBU_FFMPEG` → PATH → winget 装的位置——Kagura 可能是装 ffmpeg 之前起的，PATH 里还没有），宽 1280 的 JPEG，图片直接作为 MCP image 给她，存 `<状态目录>/snapshots/` 只留 `KEEP` 张。
  别改坏的点：① 访问码在地址里，ffmpeg 的报错会带出来——给她 / 打日志前一律 `redact`；② 拍之前先删目标文件（同一秒拍两次文件名一样，拍失败会被当成拍到了上一张）；③ 拍不到先提「局域网模式直播（LAN Only Liveview）」和「别的软件正在看直播」；④ **ffmpeg 要带 `-tls_verify 0`**（LRN 2026-11-15，症状「WSL 里的 ffmpeg 6.1 能拍，winget 装的 9.0 报 Peer certificate failed verification」：新版默认校验证书，打印机是自签的）——关了校验冒充的机器就能骗到访问码，所以拍之前 `checkCameraCert` 先自己连摄像头端口核对指纹：和 MQTT 记下的一样，或和以前在摄像头端口记下的（`camera` / `cameraHost`）一样才拍，不一样不调 ffmpeg，`printer_retrust` 一起忘掉。不需要开发者模式，`BAMBU_CONTROL=0` 也有。真机（P2S）拍通过。
  **料盒烘干（`printer_ams_dry`，2026-11）**：`{"print": {"command": "ams_filament_drying", ams_id, temp, cooling_temp: 45, duration（小时）, mode: 1 开 / 0 停, rotate_tray, …}}`（ha-bambulab 的格式；`cooling_temp` 低于 45 会被忽略）。
  料盒型号靠连上时发的只读 `get_version`（`info.module` 的名字前缀：`n3f/` = AMS 2 Pro、`n3s/` = AMS HT…，`amsModelsOf`），认出不能烘干的就不发；温度上限 AMS 2 Pro 65℃、HT 85℃，1~24 小时；
  状态 `ams[].dry_time`（分钟）从有变 0 = 烘干完，发 `dried` 通知（刚连上时看到的不算）。P2S 固件 01.01.50.40 以上才有烘干设置。
  Kagura 这边配 **`"ownerOnly": [工具名]`**（`mcp.ts`，通用）：这些工具只在主人本人的对话里有（`sceneOf(scope) === "owner"`），待办 / 定时任务 / heartbeat / 子任务 / agent 间都没有——模板里给 `printer_print` / `printer_control` 配上了。
  **字段含义全部来自社区逆向（ha-bambulab 等），写的时候没有真机（P2S）**：解析一律「有就用、没有就空着」，新机型的温度可能在 `device.*.info.temp`（目标 << 16 | 当前）；
  哪项不对让主人叫她调 `printer_status raw=true` 把原始数据发过来，照着改 `parseStatus`，测试里的 `FULL` 同步改。测试用 aedes 当假打印机、管道当标准输入输出（`test/printer.test.ts`），
  契约测试用打包好的程序真的自己拉起自己（`test_bundled_printer_mcp_and_notify`）。
- **Blender 建模 = 自带的 MCP 服务器（`server/src/blender/`，`kagura mcp blender`，2026-11）**：主人要「不用一直开着 Blender」的版本（现成的 blender-mcp 要开着 Blender、点 Start Server），所以每次调用后台起一个
  `blender -b --factory-startup --python <harness> -- <参数.json>`，跑完就退。`harness.ts` 是在 Blender 里跑的 Python：空场景（单位毫米）→ 跑她的代码 / 导入 STL·OBJ → 合起所有可见网格（修改器生效）检查（尺寸、体积、破洞边 `boundary`、
  非流形边、孤立点、放不放得下 `MODEL_BED`）→ 导出 STL → 四个角度 Workbench 渲染拼一张图（图片作为 MCP image 交给她看）。别改坏的点：
  ① `bpy.ops` 的 `hasattr` **永远是真**，新旧接口（4.1 起 `wm.stl_export` / 之前 `export_mesh.stl` 插件）用 `call_first` 挨个试；② 有的发行版的 Blender 没带 numpy，拼图用纯 Python；
  ③ 没显卡时 Workbench 靠 Mesa 软渲染（要 libEGL），失败退 Cycles CPU 并关降噪（有的没编进降噪库）；④ 文字 / 曲线转网格后**合并重合点**，不然整圈算破洞；只有 `boundary`（破洞）算问题，物体贴在一起的非流形边只提一句；
  ⑤ 一次只跑一个 Blender，临时目录每次删。
  **预置小函数 + 建模指导**（`helpers.ts` / `guide.ts`，`model_guide`）：她的代码之前先 exec 一段小函数（box / cylinder / cone / sphere / text3d / cut / union / intersect / move / rotate / round_edges / drop：
  at 是底面中心、布尔一律 EXACT 且做完就应用并删掉工具物体、缩放已应用、文字转网格合并点）——比让她从 bpy 底层拼可靠得多。`_activate` 要跳过空引用（删过物体后 `view_layer.objects` 里会挂着 None）。
  指导分节（basics / helpers / printing / fits / review / look / examples / problems），用到才读、不占每轮额度。规则和数字是读了几个开源 agent 技能（flowful-ai/cad-skill、parhamdb/3d-print-skill、
  m-esm/3d-print-modeling、swh/openscad-skill、TrillyD13/3d-printing-skill、roble3/cc-blender-skill）后用自己的话重写的——**别整段照抄它们的原文**（有的是非商用许可）；间隙一律注明单边 / 直径；**示例代码在 `test/blender.test.ts` 里用真的 Blender 逐个建一遍**（封闭、放得下），改示例 / 小函数要重跑，看一眼渲染图（形状对不对测试看不出来）。测试：`test/blender.test.ts` 在装了 Blender 的机器上真跑（CI 没装就跳过），契约测试只验能拉起和参数报错。
- **build123d 建模 = 自带的 MCP 服务器（`server/src/cad/`，`kagura mcp build123d`，2026-11）**：和 Blender 那个并列（主人「顺便做一个 build123d 的吧」）。build123d = Python 参数化 CAD（OpenCascade，Apache 2.0），精确实体、不出破洞、能导出 STEP。
  每次调用起一个 Python（`harness.ts`：`from build123d import *` → 跑她的代码 → 取 `result`（没写就取最后一个有体积的变量、并提醒）→ 有效性 / 实体数 / 体积 / 包围盒 → STL + STEP；她 print 的收进 `output`）。
  **网格检查和预览图在 Node 里按 STL 做**（`raster.ts`：读二进制 / 文本 STL、焊点数破洞边、软件光栅化四个角度 + 深度二阶差分描边、手写 PNG 编码），不依赖 Blender / numpy；`cad_preview` 看现成 STL 不需要 Python。
  别改坏的点：① 找 Python（`findPython`）：env `PYTHON`（可带参数，如 `py -3.12`；**相对路径要转绝对**——建模在临时目录里跑）→ Windows `py -3` / `python` → `python3` / `python`，探测 `import build123d`，找不到说清楚怎么装；
  ② 跑的时候 `-I`（不读当前目录 / 用户 site 的同名模块）+ `PYTHONIOENCODING=utf-8`；③ 检查结果的话术复用 Blender 的 `describeReport`，指导的 printing / fits / review / look 四节用 `sharedSection`（两边同一份），build123d 自己只写 basics / api / examples / problems；
  ④ 中文字体：`CJK_FONTS` = 系统里找到的全部（先中文、后日文，含 `%LOCALAPPDATA%` 下只给当前用户装的），`CJK_FONT` 是第一个；代码里有中文 Text 时回复里说清用的哪个、缺字（日文写法的「楽」中文字体里常没有）换日文字体——Blender 的 text3d 同一份列表；⑤ Box / Cylinder 默认**居中**，指导里反复强调 `align=(…, …, Align.MIN)`；⑥ 示例在 `test/cad.test.ts` 里真跑（`PYTHON=<装了 build123d 的 python>`，CI 没装就跳过），改示例要重跑、看渲染图。
- **看护打印（`BAMBU_WATCH_MINUTES` + `"wake": true`，`mcp-server.ts` 的 `watchTick` / `watchPrompt` / `CHECK_POINTS`，2026-11）**：打印期间每隔 N 分钟（最少 `WATCH_MIN_MINUTES` = 3）发一条 `kagura.wake`，
  她调 `printer_check`（状态 + 机内照片 + 检查要点，一次给齐）——正常回 `NO_REPLY`，明显打坏了（炒面、脱板、喷嘴裹料、空打）告诉主人，`BAMBU_CONTROL=1` 时先 `printer_pause`。
  别改坏的点：① `printer_pause` **只能暂停**（随时能继续），所以不进 `ownerOnly`；`printer_control` / `printer_print` 仍只给主人本人的对话——别为了省事把它们放给后台；
  ② 只在 `state === "printing"` 时叫，刚开始打先等满一个间隔（前几分钟在调平、加热，照片没意义），暂停 / 打完 / 断线清零；③ 拍不到照片也返回状态、不算错（她按「看不出问题就当正常」处理）；
  ④ 提示词里「拿不准不要暂停」是刚需：误暂停比漏报更烦（长打印半夜被停住）。判断靠模型看一张俯视照片，**没在真机的失败现场验证过**，检查要点是按常见失败写的，真遇到漏报 / 误报就改 `CHECK_POINTS`。
