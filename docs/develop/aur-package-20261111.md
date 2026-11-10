# AUR 包 `weq-bin`：为什么这么做

2026-11-11。新增 Arch Linux 的预编译包渠道：AUR 上的 `weq-bin` 由 release 工作流自动更新。

## 用 tar.gz，不用 AppImage

上游三个 Linux 产物里，只有 tar.gz 是「普通目录 + 可执行文件」：

```
weQ-<ver>-linux-<arch>/
  @weqdesktop            ← 可执行文件
  resources/             ← app.asar + resources/ + node_modules
  native/linux/<arch>/   ← nt_helper.node + 授权助手
```

主进程按 `process.execPath` 的相对位置找 `resources/`（`main/resource.ts`）和 `native/`
（`packages/native/src/loader.ts` 的 `resolveNativeRoot`：`dirname(resourcesPath)/native`）。
所以整个目录要原样落到 `/opt/weq`，一个文件都不能搬。

AppImage 是单文件 FUSE 镜像，拆出来的内容依赖挂载点，不适合当 pacman 的安装内容。

## 可执行文件叫 `@weqdesktop`

`electron-builder` 的 Linux 可执行名取 `appInfo.sanitizedName`（`linuxPackager.js`），
而 `packageName` 是 `@weq/desktop` → sanitize 成 `@weqdesktop`。`.desktop` 的 `Exec`
不写死它，走 `/usr/bin/weq` 包装脚本，以后改名只改一处。

## 窗口类名是 `weq-desktop`，不是 `weQ`

`.desktop` 的 `StartupWMClass` 必须和窗口实际的 `WM_CLASS` 一致，否则任务栏按应用
合并会失效。官方 AppImage 的 `.desktop` 写的是 `StartupWMClass=weQ`（来自
`productName`），但实测（2.6.0，X11）窗口 `WM_CLASS` 是：

```
WM_CLASS(STRING) = "weq-desktop", "weq-desktop"
```

Electron 用 `app.name` 生成，而 `app.name` 来自打包后的 `package.json` 的 `name`
（`@weq/desktop`），`@` 和 `/` 被换成 `-`。AUR 包按实测值写 `weq-desktop`。

## 应用内更新：AUR 副本不能自更新

`electron-updater` 在 Linux 固定走 `AppImageUpdater`，它的 `isUpdaterActive()` 要求
`$APPIMAGE` 存在；AUR 版没有，于是「检查更新」正常、点下载必然在全部镜像上失败一遍。
而且即使下载成功，替换 `/opt/weq` 里的文件也会被 `pacman -Syu` 覆盖或留下孤儿文件。

所以加了 `apps/desktop/src/main/update/managed.ts`，两个显式标记任一命中即视为托管：

1. `WEQ_PACKAGE_MANAGED=1` —— `/usr/bin/weq` 包装脚本导出（正常启动路径）；
2. `<安装根>/.weq-package-managed` —— PKGBUILD 在 `package()` 里写的标记文件
   （用户直接执行 `/opt/weq/@weqdesktop`、绕过包装脚本时的兜底）。

命中后：

- `checkForUpdate()` 照常工作，`UpdateState.managed` 置真；
- `startDownload()` / `quitAndInstall()` 直接抛错并给出 `paru -Syu` 提示，
  不再走镜像；
- 设置 → 版本 与「内置组件过期」弹窗都把「立即更新」置灰并显示该提示。

托管标记走**已有的** `update.getState`，不新增 RPC：渲染层的 `useAppUpdate`
直接在 `state.managed` 上判断。新增查询会让这个 hook 多一个订阅，
`settings_activity_resources.test.ts` 对「页面隐藏时订阅数为 0」有硬性断言。

**不要**在这类包里写 `$resourcesPath/package-type`（值 `pacman` / `deb` / `rpm`）——
那会让 electron-updater 切到 `PacmanUpdater` 去 `pacman -U` 一个 tar.gz，直接失败。

## `chrome-sandbox` 要 setuid

上游 tar.gz 里 `chrome-sandbox` 是普通 `0755`：AppImage 挂在 nosuid 的 FUSE 上，
本来就要 `--no-sandbox`；tar.gz 解压到用户目录时用 unprivileged userns。装到
`/opt/weq` 后按 Arch 自家 `electron` 包的做法补 `root:root` + `4755`，这样在关闭
user namespace 的机器上也能用沙箱。

## 发版流程

`release.yml` 的 `aur` job，在 `publish`（Release 公开）之后、`qq-notify` 之前：

1. 只对 `gate.outputs.release == 'true'` 的真发版执行；
2. 从 Release API 的 `assets[].digest` 取两个 tar.gz 的 sha256（就是 `sha256:<hex>`，
   实测与 `sha256sum` 一致），**不下载 250 MB**；
3. `scripts/publish-aur.mjs` 渲染 `packaging/aur/PKGBUILD.in`、生成 `.SRCINFO`
   （与 `makepkg --printsrcinfo` 逐字节一致）、提交并推 AUR。

需要两个仓库 secret：`AUR_SSH_PRIVATE_KEY`（`~/.ssh/aur` 的内容）、
`AUR_SSH_KNOWN_HOSTS`（`aur.archlinux.org` 的主机公钥，预先写死而不是 `ssh-keyscan`，
避免被中间人喂假 host key）。

本地补发：

```bash
node scripts/publish-aur.mjs --version v2.6.0          # 推送
node scripts/publish-aur.mjs --version v2.6.0 --dry-run # 只看渲染结果
node scripts/publish-aur.mjs --version v2.6.0 --no-push # 提交到临时克隆，不推
```

## 已验证

- `makepkg -f` 实跑 `x86_64`：包 240 MiB，解压 568 MiB，`pacman -T` 依赖全满足，
  `ldd @weqdesktop` 与 `nt_helper.node` 无缺失库；
- `ELECTRON_RUN_AS_NODE=1 ./@weqdesktop` 能加载 `nt_helper.node`；
- 真实启动（X11）：窗口出现、`WM_CLASS=weq-desktop`、`--ozone-platform=x11`
  由应用自己补上（`ozoneRelaunchArgs`）；
- `.SRCINFO` 与 `makepkg --printsrcinfo` 的 diff 为空；
- `aarch64` 产物来自 release 的 `linux-arm64.tar.gz`（架构核对为 ELF aarch64），
  **未经真机实测**。
