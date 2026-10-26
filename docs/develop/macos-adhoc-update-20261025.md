# macOS ad-hoc 更新安装（2026-10-25）

## 已确认断点

本机已安装应用的 `codesign -d -r-` 输出为 `Signature=adhoc`，designated requirement
仅包含当前构建的 `cdhash`。Squirrel.Mac 将旧应用的 designated requirement 用于验证
新包，因此新旧包即使分别通过严格签名完整性检查，仍会因构建哈希不同而拒绝更新。
2026-10-22 的退出事件修复只处理窗口关闭守卫，不能解决发布者身份问题。

依据：[Squirrel.Mac 签名验证源码](https://github.com/Squirrel/Squirrel.Mac/blob/main/Squirrel/SQRLCodeSignature.m)、
[Apple 代码要求语言](https://developer.apple.com/library/archive/documentation/Security/Conceptual/CodeSigningGuide/RequirementLang/RequirementLang.html)。

## 修复边界

- 只分流已确认使用 ad-hoc 签名的 macOS 打包应用；真实证书签名、Windows 和 Linux
  保留原安装器，不在系统签名失败后擅自降级。
- 镜像仍通过 electron-updater 下载及 SHA-512 检查，但镜像自身的清单不充当发布者身份。
  解压前必须从固定 `https://api.github.com/repos/weq-devs/WeQ/releases/tags/v<版本>`
  取得已发布正式版、对应架构 ZIP 的 SHA-256 和大小，再流式核对全部字节。
  API 使用 HTTPS 且不接受重定向，失败或缺少哈希即停止，不改用镜像提供的哈希。
  字段契约已对官方实际 Release 返回核验，见 [GitHub Release API](https://docs.github.com/en/rest/releases/releases#get-a-release-by-tag-name)。
- `ditto` 只解压已核验归档；验证 `codesign --verify --deep --strict`、bundle ID、
  短版本及 Mach-O 架构。暂存目录位于当前应用同卷，位置不可写时不提权、不提前退出。
- 用户确认安装后启动 asar 外独立助手。助手先核就绪，只在 `will-quit` 显式提交且
  父进程确已消失后移动目录。应用未退出、IPC 中断或助手失败时不替换。
- 替换前后不覆盖已有目录：旧应用移入本次暂存目录，新应用移到原位置。替换或系统启动
  失败会恢复旧路径；恢复也失败时回执保留旧应用真实位置。新版本启动确认后才清理副本。
  不清理用户数据，不改隔离属性、SIP、Gatekeeper、系统证书或代码要求。
- 准备、提交、成功与失败使用原子回执；下载后未安装的暂存会在下次启动清理。
  安装前再次核对原应用版本，等待期间若已被其它版本替换则停止，避免旧计划降级新安装。

此路径以官方仓库的 HTTPS Release 资产元数据作为更新来源的信任锚，而不是声称
ad-hoc 具有稳定发布者身份。它不能代替 Developer ID、公证或保护已失陷的官方发布账号。

## 验证与迁移

单测覆盖同版本同架构官方资产、缺失哈希、不可达、字节变化、回退版本、目录与签名检查、
助手退出握手、安装失败重试、替换和启动失败回退。macOS 定向原生测试使用临时编译的
小应用，真实复现旧 cdhash 拒绝新包，再验证签名、ZIP、父进程退出与原位替换链路；
不读取 QQ 数据、不联网、不修改已安装 WeQ。

旧版本本身没有此安装路径，无法通过给它换一个新 ZIP 自我修复。需要手动覆盖安装一次
含修复版本；本地源码提交、打包成功与已发布、已安装、实际业务验收分别记录。
