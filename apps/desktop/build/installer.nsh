; WeQ 卸载时顺手清掉 weq-daemon（electron-builder 的 NSIS 会自动 include
; buildResources 下的 installer.nsh，buildResources 见 electron-builder.yml 的
; directories.buildResources）。
;
; 为什么必须在这里做：守护进程是「全机唯一一份原生自启注册」的持有者，而它整个
; 活在数据目录 %LOCALAPPDATA%\weq-daemon\ 里 —— 既不等于 electron 的 install dir，
; 也不等于 userData，卸载器默认一个字节都不会碰。不清理的后果就是线上反馈过的
; 「卸载了还在」：WeQ 卸载之后，每次登录照旧被计划任务拉起来（1.0.2 的守护进程
; 是控制台程序 —— 于是桌面上还多一个不会自己关闭的黑框），并且徒劳地去拉起一个
; 已经不存在的 WeQ.exe。
;
; 三步都 best-effort：任何一步失败都不该让卸载流程失败（留个 0.7 MB 的二进制
; 远比卸载卡住好）。
;
; nsExec::ExecToLog —— 被执行的守护进程是控制台程序，nsExec 用隐藏窗口跑它，
; 卸载过程不会闪出黑框。

!macro customUnInstall
  ; ⚠️ 升级（electron-updater 会带着 --updated 调旧卸载器）时绝不能动守护进程：
  ; 那只是「换个新版本」，不是「卸载 WeQ」。清掉的话，开机自启会莫名其妙失效、
  ; 推文卡片的服务记忆也会一起没。这个判断与 electron-builder 的 uninstaller.nsh
  ; 模板在 un.install 段里的用法完全一致。
  ${ifNot} ${isUpdated}
    ; 1) 停掉正在跑的守护进程：它是常驻进程，不主动停就活到重启（而且是它把
    ;    数据目录里的二进制占着，导致下面删不掉）。本来就不在时这条命令会失败，
    ;    忽略即可。
    nsExec::ExecToLog '"$LOCALAPPDATA\weq-daemon\bin\weq-daemon.exe" stop'
    Pop $0

    ; 2) 删掉开机自启任务。走 schtasks 而不是 `weq-daemon.exe uninstall`：即使
    ;    数据目录已经被清掉 / 二进制缺失，任务也不会变成没人认领的残留。
    nsExec::ExecToLog '"$SYSDIR\schtasks.exe" /Delete /TN weq-daemon /F'
    Pop $0

    ; 3) 清掉 stage 出来的二进制与隐藏拉起器、状态文件（http 记忆 / GUI 自启记忆 /
    ;    release 状态）和日志。它们全在数据目录下、都是守护进程自己写的，不属于
    ;    electron 的 userData。文件若仍被占用就先挂起来，下次重启时删除。
    RMDir /r /REBOOTOK "$LOCALAPPDATA\weq-daemon"
  ${endIf}
!macroend
