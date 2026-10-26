# 应用内服务与独立自启（2026-10-25）

## 当前实现

不再构建、打包、拉起或注册独立 `weq-daemon`。Rust 工作区及其发布步骤已移除。
历史可再生产物仍被 Git 忽略，并被桌面／Web 打包明确排除，不清理本机未知现场。

- 助手卡片路由保留 `/p/*`、`/cover/*`、`/avatar.png`，资源由当前宿主进程内的
  `AssistantResourceServer` 提供，默认不监听。只有开启助手才发布并监听回环端口。
- 端口占用时向后回落最多 20 个；真实路径必须留在 docroot 内，拒绝目录外符号链接、
  路径穿越和超出 16 MiB 的文件。只处理 GET／HEAD，连接和请求时限有界。
- 停用助手关闭监听；完全退出永久拒绝迟到的启动，发布途中停用也不能重新开启。
  关闭到托盘仍属于应用运行。Web 服务结束时同步释放其进程拥有的服务。
- 版本检查复用 `update/updater.ts`，不再提供独立后台 GitHub 轮询。QQ 已有缓存可能
  继续显示，退出后不承诺助手资源仍可读取。

## 系统直接自启

只有安装版桌面宿主允许操作自启。开发态不修改日常系统登录项或旧后台；Web 由部署方
管理。macOS／Windows 使用 Electron 登录项接口，读取系统返回，不把待批准、任务
管理器禁用或注册失败冒称已生效。Linux 使用 XDG 桌面自启项，不创建常驻重启单元；
AppImage 使用 `$APPIMAGE`，而不是每次变化的挂载路径。

依据：[Electron 登录项接口](https://www.electronjs.org/docs/latest/api/app#appsetloginitemsettingssettings-macos-windows)、
[XDG 自启约定](https://specifications.freedesktop.org/autostart-spec/latest/)、
[Desktop Entry Exec 转义](https://specifications.freedesktop.org/desktop-entry/latest/exec-variables.html)。
Linux 路径转义覆盖两层反斜杠、引号、美元符、反引号和字面百分号，拒绝规范不允许的
等号及控制字符路径。真正登录启动仍需各平台安装后的实机点验。

## 升级迁移

迁移先读取旧 `weq-daemon.gui.json`，保留开启自启的选择；已有系统登录项不因旧偏好
关闭而被关闭。应用 userData 中的 `legacy-daemon-migration.json` 分别记录自启已迁移
与旧后台已退役，原子落盘。清理失败可在下次启动重试，不重放旧选择覆盖用户的新设置。
每次启动仍复核旧入口，覆盖回滚到旧版本后重新注册后台的情况；不设置常驻监听或定时轮询。

仅处理固定旧 label／任务名 `weq-daemon`、`weq-daemon-gui`，核对注册内容后停用和
移除旧入口，再用旧管道请求停止并等待探活消失。旧数据、推文、日志、二进制不删除，
不执行旧二进制，也不关闭可能被其他服务使用的 Linux linger。旧配置损坏、权限失败
或后台未停止会保留现场并在自启页显示迁移未完成。

旧后台启动的 GUI 可能仍处于旧服务进程组／cgroup 内，直接停止旧服务可能连带杀死
当前 WeQ。检测到这种实际归属时不强拆，显示退出后从系统启动器重开的原因；macOS
旧的一次性 GUI 登录项仅移除文件，不 bootout 当前 GUI 本身。

旧协议客户端仅留作一次性退役兼容，不再作为新功能或运行时服务入口。

## 验证边界

定向测试覆盖进程内服务、迁移、系统登录项读写契约、设置入口及构建依赖移除。
安装与实际登录自启状态、打包结果和可视化验收分别记录，不从单测推断实机已部署。
