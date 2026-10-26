# 长期授权集成（2026-10-26）

## 边界与产物

不新增源码仓库或发布仓库。现有私有 `nt_helper` workspace 构建两个运行产物：应用加载的 `nt_helper.node`，以及独立的 `weq-authorization-helper`（Windows 为 `.exe`）。助手按需复用原生核心源码，不携带 Electron、Node、SQLite 或完整业务服务；共用源码并不意味着机器码完全不重复。

公开 WeQ 仅维护设置、受限提示的共享跳转按钮、主进程 IPC 客户端及产物下载校验。敏感原生实现、系统服务安装和有效性约束留在现有私有仓。本文只描述必要的集成契约，不复制私有源码或内部实现参数。

管理接口仅允许本机主窗口的主 frame 调用，不通过 Web、Remote 或业务 RPC 暴露安装/撤销。运行接口使用本机 Unix socket / Windows named pipe，用户身份由操作系统取得，不接受客户端声明的身份，也不保存长期 bearer token。权限范围是获授权的系统用户，不是任意远程调用者。

## 兼容与回退

普通读取先走现有非特权路径，权限不足时尝试助手，再保留原有临时授权。抓包通过现有 worker 接口代理 start/take/stop，复用消息映射；连接拥有自己的会话，断开后清理。状态中的 `longTermAuthorized` 与当前进程是否 elevated 分开，不伪造进程提权状态。

兼容性按协议版本和操作能力判断，不要求助手 hash 与当前 `.node` 相同。助手过期则拒绝敏感操作，状态检查、清理与卸载仍可用；修复安装才会替换助手，普通 app 更新不隐式申请管理员权限。

## 分发契约

沿用 native release 的 `manifest.json`，增加可选顶层字段：

```json
{
  "authorization": {
    "darwin-arm64": {
      "asset": "weq-authorization-helper-darwin-arm64",
      "sha256": "<64 位小写十六进制摘要>",
      "size": 1234567
    }
  }
}
```

平台键与 `platforms` 相同。Windows 资产名带 `.exe`。新字段存在时必须校验名称、大小和 SHA-256；缺失时保持旧包兼容，不构造未经校验的下载链接。助手与 `.node` 放在同一平台目录，由现有桌面打包目录规则收集，不再复制整套运行环境。

上例只展示资产定位字段。正式清单还包含助手通过 `build-info` 自报的 `protocol`、`target`、`capabilities`、`buildTime`、`expireTime`、`validitySecs`、`isDev`；不在 WeQ 再定义有效期。发布构建要求 `isDev=false`，目标/协议兼容、未过期，且与 `.node` 的时间戳和有效期相同。

私有构建脚本生成单平台助手与清单片段；既有发布仓的本地工作流修改已接上构建、验证、上传白名单与总清单汇总，未新建远端仓库。源码实现、构建通过、资产发布、系统安装和跨平台真机验收是不同状态，不能互相替代；本次准备不自动推送、发布、更新锚点或安装系统服务。

## Release 门禁

- 桌面五个平台均执行 `--require-fresh --require-authorization --verify`，不再允许缺助手的旧 tag 作为新桌面 release 输入。日常开发仍兼容旧清单；Web 使用 `--no-authorization`，压缩包显式排除权限助手。
- fetch 先暂存并校验整套资产，再逐文件原子替换，助手校验失败不先覆盖 `.node`；`--verify` 成功后才允许 `--write-pin`。安装记录保存最小公开助手元数据，`--check` 也核对必需资产，不只信任旧记录。
- `pnpm native:preflight` 以只读检查模式核对锚点、完整性、新鲜度和真实宿主双产物，不安装服务；它不会下载替换资产或写锚点。旧锚点或本地开发构建被拒绝是预期结果，不能为通过预检放宽门禁。
- release 的 `WEQ_REQUIRE_AUTHORIZATION_HELPER=1` 在 `afterPack` 检查包内助手的体积、SHA-256、执行权限及真实构建信息，同时核对包内 `.node`。`afterSign` 复用同一检查，只比较不会被签名改写的构建信息；不能把签名前 hash 用来误拒签名后的文件。
- `afterSign` 使用 electron-builder 的 PackContext 架构，不依赖 mac.sign 回调中并不存在的 `arch`。macOS 原有深度签名校验保留，不修改系统安全策略。`WEQ_NATIVE_MANIFEST` 仅用于隔离打包演练或明确的 staging 输入，默认读取 `native/.installed.json`。

## 开发模式

`pnpm dev` 可以使用权限助手。默认使用 native 平台目录中的组件；也可显式指定现有私有仓编译的可执行文件，不复制私有源码或额外运行环境：

```sh
# 在已有私有 native 仓构建，显式清除子进程的发布戳，得到隔离开发助手。
node scripts/build-authorization-helper.mjs --development

# 回到 WeQ；路径必须指向本机对应平台的可执行文件。
WEQ_AUTHORIZATION_HELPER_PATH=/absolute/path/to/weq-authorization-helper-darwin-arm64 pnpm dev
```

Windows PowerShell 先设置 `$env:WEQ_AUTHORIZATION_HELPER_PATH = 'C:\absolute\path\weq-authorization-helper-win32-x64.exe'`，再运行 `pnpm dev`。Linux 使用 `linux-x64` / `linux-arm64` 的产物。现有包内发布助手也可以被开发宿主复用；需要单独调试时选择开发构建。

开发构建使用独立的 `app.weq.authorization.dev` 服务和对应的系统目录/IPC 通道，不覆盖正式助手及其用户授权记录；只有显式安装开发通道时才多一份小型可执行文件。设置仍复用同一管理组件，标为「长期授权（开发）」，启用/修复/撤销依旧需要管理员批准。启动开发服务器、打开设置、重编译或检查状态均不会自动安装服务。

正式安装版忽略开发路径覆盖，并拒绝开发构建作为管理组件；客户端也校验运行通道，不将开发服务当作正式服务使用。重编译本地助手后，下次检查会刷新诊断缓存；若组件在安装暂存期间切换通道，会在提权前停止并要求重试。旧的、尚未隔离通道的开发助手需要重新编译。

开发构建继续遵循 native 既有的本地 dev 有效性策略；正式发布、新鲜度和包内检查仍拒绝开发产物，不为支持开发模式放宽 release 门禁。过期发布组件仍可用于撤销，不能重新安装成可用组件。

## 发布顺序

1. 合入既有发布仓的工具/工作流，再使私有 native 的助手与诊断入口在远端可构建；不发布或记录不存在的 tag。
2. 对明确的 native commit 运行 `preflight_only=true`。该模式没有 draft、资产上传或 latest 更新；五平台实际编译结果与本地合成检查分开记录。
3. 正常 native 发布生成完整且校验通过的 tag 后，在 WeQ 对同一个明确 tag 执行 `pnpm native:fetch --version <tag> --require-fresh --require-authorization --verify`。
4. 确认后再对同一 tag 增加 `--write-pin`，提交真实锚点。随后才进行 WeQ 桌面 release；当前旧锚点会被新增门禁明确拒绝，不伪装准备完成即已发布。

三平台系统安装验收应分别记录：首次管理员批准、当前用户就绪、重启/应用更新后复用、撤销中断、其他已授权用户不受误删、最后用户卸载。另核对 macOS SIP 限制仍生效、Windows Npcap 缺失不报可抓包、Linux 无 systemd 保持临时回退，以及 AppImage/FUSE 安装暂存。此清单不自动执行这些有副作用的操作。

## 本地验证

已完成 macOS arm64 的原生构建与合成测试、桌面端 node/renderer 类型检查，以及客户端、设置、提权、导出、服务回退和资产清单的针对性测试。实际组件在隔离浏览器中检查了深浅主题、两种主题色、1100/390 像素视口与减少动态效果，无横向溢出；启用和撤销使用合成桥接，不代表系统安装验收。

Windows / Linux 的源码路径已实现，工作流已准备对应构建与测试门禁，但尚未触发远端执行或完成真机安装。当前 pinned tag 尚不包含助手，保持不变。未进行真实 QQ 内存读取、抓包或系统服务安装；隔离最小打包只验证 native 目录映射、签名与钩子，不替代完整桌面发布验收。
