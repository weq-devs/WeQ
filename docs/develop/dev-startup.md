# 一行命令开发启动

在仓库根目录运行：

```sh
pnpm dev
```

首次运行会安装项目依赖、准备 Electron、补齐当前平台的 native 与装扮资源、构建远程网络辅助程序和机器人运行时，然后进入桌面开发及热更新流程。内置 Web、主进程、预加载和渲染构建继续由现有开发链路完成。从 `apps/desktop` 运行 `pnpm dev` 也进入相同流程。

## 基础环境

- Node.js 至少 22.12.0，pnpm 使用根清单锁定的版本。
- 首次或网络助手源码变化时需要 Go，版本遵循仓库 `tools/remote-network/go.mod`。
- 默认使用发布版 native，不要求 Rust 或 native 私有仓访问。本地源码模式需要对应平台的 Rust/Cargo、系统编译依赖及完整 native 源码和装扮原始输入。

启动器自动准备项目依赖与项目构建，不安装系统工具链。缺少工具或构建失败时停止，并保留错误输出和非零退出码。

## 来源配置

共享默认值在 [weq.dev.json](https://github.com/weq-devs/WeQ/blob/dev/weq.dev.json)。本机覆盖写到根目录 `weq.dev.local.json`，该文件不入库。

默认配置：

```json
{
  "native": { "mode": "release", "jobs": 2 },
  "userDataDir": ".dev-profile"
}
```

参与 native 开发时，本机配置改为：

```json
{
  "native": {
    "mode": "local",
    "source": "../nt_helper",
    "jobs": 2
  }
}
```

路径相对 WeQ 仓库根目录解析，与运行命令时的工作目录无关，也接受绝对路径。

| 配置 | 行为 |
| --- | --- |
| `native.mode: release` | 使用 `native/pinned.json` 指定的明确发布版本，不自动跟随 latest |
| `native.mode: local` | 检查配置源码的构建输入，变化时自动编译、验证并安装，不再等待回车确认 |
| `native.source` | 本地 native 仓库路径，`local` 模式必填 |
| `native.jobs` | Cargo 构建任务数，默认 2 |
| `userDataDir` | 默认 `.dev-profile`，隔离开发数据；设为 `null` 则使用应用原有默认用户目录 |

`WEQ_NATIVE_MODE`、`WEQ_NATIVE_SOURCE` 可覆盖 native 模式与源码目录。发布版模式沿用现有 `NT_HELPER_RELEASE_REPO`、`NT_HELPER_RELEASE_BASE_URL`、`NT_HELPER_VERSION` 和代理配置；版本覆盖必须是明确 tag。Electron 镜像沿用 `ELECTRON_MIRROR` 等安装器配置，启动器不写死镜像、用户路径或包管理器安装位置。

native 来源由配置明确决定：本地编译失败不会改用发布版；发布版过期不会自动改取 latest。若项目版本锚已过期，应按[原生产物分发说明](native-artifacts.md)验证并升级锚点，重新下载同一版本不能延长有效期。

## 缓存与安装

- 项目依赖按工作区清单、锁文件、安装元数据、Node/pnpm 环境和直接依赖实际文件检查。需要补齐时执行 `pnpm install --frozen-lockfile --prefer-offline --prod=false`，确保开发依赖也安装，不改锁文件。
- native 同时检查来源、平台、安装文件哈希及真实加载结果，三类装扮资源必须查询成功；普通启动不会每次联网获取发布清单。
- 本地指纹包含源码、依赖清单、vendor、Cargo 配置及被 Git 忽略的三类装扮原始资源。普通文档、target 产物变化不触发编译。按当前平台显式选择 Rust target 及 `.dll`、`.so` 或 `.dylib`。
- native 和三份 `.dat` 在暂存区验证后成套替换；失败时恢复已经替换的文件。安装来源保存在不入库的 `native/.installed.json`，不改 `pinned.json`，不自动安装系统权限助手。
- 网络助手按 Go 源码和产物哈希缓存；机器人运行时按 esbuild 的实际输入清单与产物哈希缓存。Electron 开发宿主继续复用已有完整性与签名检查。
- 同一仓库的启动及同一 native 源码的编译分别加进程锁。正常退出会释放；已记录的进程退出后可恢复其遗留锁。不会终止其他开发进程。

## 日志与命令

准备阶段和应用使用同一份终端行头实现，统一时间、级别、来源和颜色。时间沿用应用现行北京时间格式。安装、下载和构建输出逐行接入，保留真实警告、错误及定位；已有应用日志不重复添加行头。`NO_COLOR` 禁用颜色，Ctrl+C 清理本次启动的子进程。

```sh
pnpm dev --prepare-only                 # 补齐环境和构建后退出，不启动应用
pnpm dev -- --user-data-dir=/custom/dev # 显式覆盖本次开发数据目录
pnpm dev --help                         # 查看入口说明，不安装或构建
```

无桌面环境的机器可使用 `--prepare-only` 验证准备流程；真正启动仍需要系统提供 Electron 所需的图形环境和动态库。启动器的合成回归测试不依赖 native 私有源码、QQ 数据或网络下载，CI 为 Windows、Linux 和 macOS 分别安排测试。

## 应用启动画面

环境准备结束后，桌面窗口在首次绘制后显示；入口 HTML 自带 Logo、主题快照与进度条，不依赖业务模块加载。全流程使用同一份单调递增的阶段进度：资源加载 5%、恢复检查 10%、环境检查 20%、账号打开 35%、首屏身份预载 55%–80%、工作区模块加载 80%、实际绘制 90%、首屏绘制完成 100%。这些是固定工作权重，不表示剩余时间；有真实计数时按阶段区间推进，迟到回调不会倒退进度。

工作区挂载时进度条收为顶部细线，不遮挡可操作界面；首屏完成绘制后到达 100% 并移除，不等待完整联系人目录、通知或在线状态。账号选择和诊断页同样在实际界面就绪后结束启动。

本轮自动进入目标有效时，初始窗口直接使用工作区尺寸；没有目标或跳过自动进入时使用账号选择尺寸，自动进入失败则回到账号选择。窗口创建和后续布局统一使用内容区尺寸，并在隐藏时完成初始布局，重复布局通知不重置用户调整。

定向回归：`pnpm --filter @weq/desktop exec vitest run test/startup_window.test.ts test/startup_account.test.ts test/startup_surface.test.ts test/startup_theme.test.ts test/startup_progress.test.ts test/window_layout.test.ts`。实际绘制检查使用 `node apps/desktop/test/browser/run-startup-flow.mjs`；可用 `WEQ_PLAYWRIGHT_IMPORT`、`WEQ_BROWSER_EXECUTABLE` 指定已有浏览器依赖，`WEQ_STARTUP_ELECTRON=1` 同时验证隔离 Electron 窗口，不打开真实账号。
