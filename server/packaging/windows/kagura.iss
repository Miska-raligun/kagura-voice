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
Source: "{#Root}\dist\icon.ico"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#Root}\packaging\windows\使用说明.txt"; DestDir: "{app}"; Flags: ignoreversion isreadme

[INI]
Filename: "{app}\管理界面.url"; Section: "InternetShortcut"; Key: "URL"; String: "http://127.0.0.1:5000/admin"
Filename: "{app}\管理界面.url"; Section: "InternetShortcut"; Key: "IconFile"; String: "{app}\icon.ico"
Filename: "{app}\管理界面.url"; Section: "InternetShortcut"; Key: "IconIndex"; String: "0"

[Icons]
Name: "{group}\Kagura 服务端"; Filename: "{app}\kagura.exe"; Parameters: "--tray"; IconFilename: "{app}\icon.ico"
Name: "{group}\Kagura 管理界面"; Filename: "{app}\管理界面.url"; IconFilename: "{app}\icon.ico"
Name: "{group}\使用说明"; Filename: "{app}\使用说明.txt"
Name: "{group}\卸载 Kagura"; Filename: "{uninstallexe}"
Name: "{autodesktop}\Kagura 管理界面"; Filename: "{app}\管理界面.url"; IconFilename: "{app}\icon.ico"
Name: "{userstartup}\Kagura"; Filename: "{app}\kagura.exe"; Parameters: "--tray --no-browser"; IconFilename: "{app}\icon.ico"; Flags: runminimized; Tasks: autostart

[Run]
; 防火墙：按程序放行（TCP 5000/1883/5002、UDP 5001 都是它开的）；所有网络类型——
; Windows 11 默认把新连的 WiFi 当「公用网络」，只放行专用网络的话设备会连不上
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""Kagura"""; Flags: runhidden; Tasks: firewall
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall add rule name=""Kagura"" dir=in action=allow program=""{app}\kagura.exe"" enable=yes profile=any"; Flags: runhidden; Tasks: firewall
Filename: "{app}\kagura.exe"; Description: "现在启动 Kagura（会打开管理界面）"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "{sys}\taskkill.exe"; Parameters: "/IM kagura.exe /F"; Flags: runhidden; RunOnceId: "StopKagura"
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""Kagura"""; Flags: runhidden; RunOnceId: "DelFirewall"
