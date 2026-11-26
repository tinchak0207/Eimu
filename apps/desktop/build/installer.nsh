; ============================================================================
;  Eimu 桌面版 NSIS 安装器 — 外观层品牌化（只碰「看得见」的东西）
; ============================================================================
;  本档由 electron-builder 的 nsis.include 自动插入到
;  computeCommonInstallerScriptHeader()，位置在 templates/nsis/installer.nsi 之前，
;  因此这里的 MUI 定义对 MUI2.nsh 与所有页面 macro 都生效。
;
;  红线：不得写任何档案系统 / 注册表 / 卸载逻辑，安装语意全交给 electron-builder 模板；
;        也不得定义任何 electron-builder 会用 -D 传入的符号 —— 编译带 -WX
;        （warningsAsErrors），重复定义 = 编译直接失败。
;
;  已由 electron-builder 以 -D 传入、此处严禁再定义：
;    MUI_ICON / MUI_UNICON（installerIcon / uninstallerIcon）
;    MUI_HEADERIMAGE / MUI_HEADERIMAGE_RIGHT / MUI_HEADERIMAGE_BITMAP（installerHeader）
;    MUI_WELCOMEFINISHPAGE_BITMAP（installerSidebar）
;    MUI_UNWELCOMEFINISHPAGE_BITMAP（uninstallerSidebar）
;    SHORTCUT_NAME / UNINSTALL_DISPLAY_NAME / RUN_AFTER_FINISH /
;    MULTIUSER_INSTALLMODE_ALLOW_ELEVATION / INSTALL_MODE_PER_ALL_USERS_REQUIRED ...
; ============================================================================

; ---------------------------------------------------------------------------
;  字型
; ---------------------------------------------------------------------------
;  MUI_FONT / MUI_FONTSIZE 是 MUI1 时代的符号，MUI2 实际取用的是语言档的
;  $(^Font) / $(^FontSize)。这里保留它们作为意图宣告（无副作用），而真正让中文
;  可读、不出豆腐块的，是 nsis.installerLanguages=["zh_CN"] 带进来的
;  SimpChinese 语言档（^Font = 宋体 9pt，codepage 936）。
!define MUI_FONT "Microsoft YaHei UI"
!define MUI_FONTSIZE 9

; ---------------------------------------------------------------------------
;  退出确认
; ---------------------------------------------------------------------------
!define MUI_ABORTWARNING
!define MUI_ABORTWARNING_TEXT "确定要退出 Eimu 安装程序吗？安装尚未完成。"

; ---------------------------------------------------------------------------
;  页面配色 —— 对齐 Emu Liquid Glass：浅底 hsl(210 23% 97%) + 海军蓝文字 #2d3142
; ---------------------------------------------------------------------------
!define MUI_BGCOLOR "F6F8FA"
!define MUI_TEXTCOLOR "2D3142"

; ---------------------------------------------------------------------------
;  欢迎页
;  electron-builder 的 assisted 安装器默认不插欢迎页，必须靠 customWelcomePage
;  hook 自己插（hook 位置在 licensePage / 安装模式页之前）。
; ---------------------------------------------------------------------------
!macro customWelcomePage
  !insertmacro MUI_PAGE_WELCOME
!macroend

!define MUI_WELCOMEPAGE_TITLE "欢迎使用 Eimu"
!define MUI_WELCOMEPAGE_TEXT "Eimu 是一个 AI 创作工作台，图片、视频与文案都在同一块画布上完成。$\r$\n$\r$\n安装会写入当前使用者的个人文件夹（%LOCALAPPDATA%\Programs\eimu-desktop），不需要管理员权限，也不会弹出 UAC 授权窗口。$\r$\n$\r$\n点「下一步」继续。"

; ---------------------------------------------------------------------------
;  完成页（runAfterFinish: true ⇒ 模板会设 MUI_FINISHPAGE_RUN / RUN_FUNCTION）
; ---------------------------------------------------------------------------
!define MUI_FINISHPAGE_TITLE "Eimu 已安装完成"
!define MUI_FINISHPAGE_TEXT "Eimu 已经装好了，桌面与开始菜单都能找到它。$\r$\n$\r$\n之后的版本更新会在后台自动完成，不需要重新下载安装包。"
!define MUI_FINISHPAGE_RUN_TEXT "立即启动 Eimu"

; ---------------------------------------------------------------------------
;  卸载欢迎页
; ---------------------------------------------------------------------------
!define MUI_UNWELCOMEPAGE_TITLE "卸载 Eimu"
!define MUI_UNWELCOMEPAGE_TEXT "这会把 Eimu 从当前使用者移除。$\r$\n$\r$\n你的作品与帐号资料保存在云端，重新安装后仍可继续使用。$\r$\n$\r$\n点「下一步」继续。"

; ---------------------------------------------------------------------------
;  安装模式：强制 per-user
;  在 multiUserUi.nsh 的安装模式页 Pre 函数里把 $isForceCurrentInstall 设成 1，
;  该页会立刻 Abort（跳页）并走 setInstallModePerUser —— 使用者看不到 Windows
;  原生的「为所有使用者/仅为我」选择页，安装结果仍是
;  %LOCALAPPDATA%\Programs\eimu-desktop、不提权。
;  静默安装（/S）不执行任何页面回调，模式由 .onInit 的 initMultiUser 依
;  HKCU 既有安装决定，所以自动更新路径不受本页影响。
; ---------------------------------------------------------------------------
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend
