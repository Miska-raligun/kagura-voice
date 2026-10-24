; Kagura Windows 安装包（Inno Setup 6）。由 .github/workflows/release.yml 调用：
;   ISCC /DAppVersion=1.2.3 packaging\windows\kagura.iss
; 产物：server\dist\Kagura-Setup-<版本>.exe
;
; 安装时做三件事（§9）：放可执行文件；加防火墙入站规则（设备要从局域网连进来）；
; 可选开机自启（启动文件夹里放一个最小化运行的快捷方式）。装完自动启动并打开管理界面的首次设置向导。
; 数据不在安装目录：在 %APPDATA%\Kagura，卸载不删（人设、记忆、对话都在那里）。

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#define Root "..\.."

[Setup]
AppId={{6F1C2B7E-5A3D-4E8B-9C21-4B7D8E0A9F31}
AppName=Kagura
AppVersion={#AppVersion}
AppVerName=Kagura {#AppVersion}
AppPublisher=Kagura Voice
DefaultDirName={autopf}\Kagura
DefaultGroupName=Kagura
DisableProgramGroupPage=yes
OutputDir={#Root}\dist
OutputBaseFilename=Kagura-Setup-{#AppVersion}
SetupIconFile={#Root}\dist\icon.ico
UninstallDisplayIcon={app}\kagura.exe
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
; 加防火墙规则要管理员权限
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
; 升级安装前先关掉正在运行的服务端（文件被占用替换不了）
CloseApplications=force

[Languages]
#if FileExists(CompilerPath + "Languages\ChineseSimplified.isl")
Name: "chs"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"
#else
Name: "en"; MessagesFile: "compiler:Default.isl"
#endif

[Tasks]
Name: "autostart"; Description: "开机自动启动 Kagura（最小化运行）"
Name: "firewall"; Description: "允许局域网里的设备连接（添加 Windows 防火墙规则，推荐）"

[Files]
Source: "{#Root}\dist\kagura.exe"; DestDir: "{app}"; Flags: ignoreversion
; 托盘版：同一个程序，可执行文件头标成「图形界面」，启动不开控制台窗口（scripts/gui-exe.mjs 生成）
Source: "{#Root}\dist\kagura-tray.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#Root}\dist\icon.ico"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#Root}\packaging\windows\使用说明.txt"; DestDir: "{app}"; Flags: ignoreversion isreadme

[INI]
Filename: "{app}\管理界面.url"; Section: "InternetShortcut"; Key: "URL"; String: "http://127.0.0.1:5000/admin"
Filename: "{app}\管理界面.url"; Section: "InternetShortcut"; Key: "IconFile"; String: "{app}\icon.ico"
Filename: "{app}\管理界面.url"; Section: "InternetShortcut"; Key: "IconIndex"; String: "0"

[Icons]
Name: "{group}\Kagura 服务端"; Filename: "{app}\kagura-tray.exe"; Parameters: "--tray"; IconFilename: "{app}\icon.ico"
Name: "{group}\Kagura 服务端（显示窗口，排障用）"; Filename: "{app}\kagura.exe"; IconFilename: "{app}\icon.ico"
Name: "{group}\Kagura 管理界面"; Filename: "{app}\管理界面.url"; IconFilename: "{app}\icon.ico"
Name: "{group}\使用说明"; Filename: "{app}\使用说明.txt"
Name: "{group}\卸载 Kagura"; Filename: "{uninstallexe}"
Name: "{autodesktop}\Kagura 管理界面"; Filename: "{app}\管理界面.url"; IconFilename: "{app}\icon.ico"
Name: "{userstartup}\Kagura"; Filename: "{app}\kagura-tray.exe"; Parameters: "--tray --no-browser"; IconFilename: "{app}\icon.ico"; Tasks: autostart

[Run]
; 防火墙：按程序放行（TCP 5000/1883/5002、UDP 5001 都是它开的）；所有网络类型——
; Windows 11 默认把新连的 WiFi 当「公用网络」，只放行专用网络的话设备会连不上
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""Kagura"""; Flags: runhidden; Tasks: firewall
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall add rule name=""Kagura"" dir=in action=allow program=""{app}\kagura.exe"" enable=yes profile=any"; Flags: runhidden; Tasks: firewall
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""Kagura Tray"""; Flags: runhidden; Tasks: firewall
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall add rule name=""Kagura Tray"" dir=in action=allow program=""{app}\kagura-tray.exe"" enable=yes profile=any"; Flags: runhidden; Tasks: firewall
Filename: "{app}\kagura-tray.exe"; Parameters: "--tray"; Description: "现在启动 Kagura（在右下角托盘，会打开管理界面）"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "{sys}\taskkill.exe"; Parameters: "/IM kagura.exe /F"; Flags: runhidden; RunOnceId: "StopKagura"
Filename: "{sys}\taskkill.exe"; Parameters: "/IM kagura-tray.exe /F"; Flags: runhidden; RunOnceId: "StopKaguraTray"
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""Kagura Tray"""; Flags: runhidden; RunOnceId: "DelFirewallTray"
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""Kagura"""; Flags: runhidden; RunOnceId: "DelFirewall"

[Code]
// 升级前结束正在运行的 Kagura（服务端、托盘版）。在线更新时服务端故意不先退出——
// 等用户在「用户账户控制」里点了「是」、安装真正开始时才在这里结束它，这样取消或失败时服务照常运行。
// CloseApplications=force 也会尝试关，但没有窗口的进程不一定关得掉，这里兜底。
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Code: Integer;
  Port: String;
begin
  // 先请正在运行的 Kagura 自己退出（它会先断开飞书 / QQ 长连接）：直接强杀的话，飞书会把消息继续投给那条死连接十几分钟。
  // 在线更新会传 /KAGURAPORT=端口；手动运行安装包时按默认端口试一下，没在跑就什么也不发生
  Port := ExpandConstant('{param:KAGURAPORT|5000}');
  Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
    '-NoProfile -NonInteractive -WindowStyle Hidden -Command "try { Invoke-RestMethod -Method Post -Uri http://127.0.0.1:' + Port + '/api/admin/quit -TimeoutSec 5 | Out-Null; Start-Sleep -Seconds 3 } catch {}"',
    '', SW_HIDE, ewWaitUntilTerminated, Code);
  // 还没退的（老版本、卡住的）照旧强制结束
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/IM kagura-tray.exe /F', '', SW_HIDE, ewWaitUntilTerminated, Code);
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/IM kagura.exe /F', '', SW_HIDE, ewWaitUntilTerminated, Code);
  Sleep(1000);
  Result := '';
end;
