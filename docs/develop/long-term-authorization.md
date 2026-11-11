# 长期授权集成

读 QQ 进程内存、读网卡抓包都要管理员权限。每次都弹密码框很难用，所以 WeQ 可以把一个
**小型原生权限助手**注册成系统服务，按系统用户登记一次授权，之后由它代做这两类操作。

这个助手不是第二个 Electron、也不是新的仓库：产物和 `.node` 一起发在
`weq-devs/nt_helper_release`，源码在私有 `nt_helper` 仓的 `authorization-helper/`。

## 一、它负责什么

| 能力 | 对应受限功能 |
| --- | --- |
| `attach` | 读 QQ 进程内存，取 a2 / d2 / d2key 等在线会话物料 |
| `key-scan` | 零注入内存扫描数据库 raw key |
| `capture` | 网卡抓包（含 PID 归属） |

助手只接受「当前系统用户的 QQ 主进程」，**不接受调用方传入的用户身份、任意命令、任意读写
路径或脚本**。装号 / 取密钥走纯协议 `quickLogin` / `qrLogin`，与它无关。

## 二、状态机

宿主只认四种状态（`LongTermAuthorizationStatus.state`）：

| 状态 | 含义 | 界面 | 能做什么 |
| --- | --- | --- | --- |
| `unavailable` | 当前宿主不提供助手（Web 端 / 平台不支持） | 「当前环境不可用」 | 只能继续用临时授权 |
| `not-installed` | 没装或已撤销 | 「未启用」 | 「启用长期授权」 |
| `ready` | 服务在跑且接口兼容 | 「已连接」 | 「修复授权」「撤销授权」 |
| `needs-repair` | 协议 / 接口 / 有效期 / 通道不匹配 | 「需要修复」+ 原因 | 「修复授权」 |

`needs-repair` 时界面上给的原因（`reason`）只有五种：`expired`、`interface-changed`、
`channel-mismatch`、`incompatible`、`unresponsive`。**不要把它降级成一句「启用失败」** ——
原因决定用户下一步是更新原生组件、还是重装助手。

受限模式里遇到 `needs-repair` 时的行为也是固定的：`attach` 不再静默回退，监视器把
`credentialsPending` 置 false，把原因交给受限模式显示，后台仍按退避重试，修好后自动恢复。

## 三、接口版本与有效期

两套版本号，别混：

| 常量 | 位置 | 作用 |
| --- | --- | --- |
| `AUTHORIZATION_PROTOCOL` | `packages/native/authorization.mjs` | 连接层能不能建立 |
| `AUTHORIZATION_INTERFACE` | 同上 + nt_helper 的 `common::AUTHORIZATION_INTERFACE` | 请求 / 响应字段与操作语义是否兼容 |

**改了请求字段或语义就递增 `AUTHORIZATION_INTERFACE`**，两边必须同时改。旧接口签发的授权
记录会被判成 `authorization-stale`，回到 `needs-repair`，用户需要再走一次「修复授权」。
`build-info` 与运行时 `status` 都会报出这个号，供宿主比对；发布检查用
`validateAuthorizationContract(nativeInfo, helperInfo)` 卡住。

有效期用的是和 `.node` **同一份常量与同一次编译戳**：

- 带 `BUILD_TIMESTAMP` 的发布构建启动时校时，之后用**单调时钟**推进，常驻进程不会永远
  停在「有效」；
- 过期后拒绝敏感操作与返回结果，但**不阻止**状态查询、停止抓包、修复与卸载；
- 发布清单里助手的 `buildTime` / `expireTime` 必须和 `.node` 完全一致，否则 `native:fetch`
  的校验会失败。

## 四、安装 / 修复 / 撤销

- 三个操作都要**系统管理员**批准，安装锁跨进程串行化；
- 同一台机器只装**一份共享二进制**，授权按系统用户登记；最后一位用户撤销时才卸载服务；
- 空闲时不抓包；连接断开 / 撤销 / 服务退出都会清掉该连接持有的会话；
- 系统服务制式：macOS `launchd`、Windows 系统服务、Linux `systemd`（Linux 没有运行中的
  systemd 时明确报错，不假装已启用）。

安装目录必须由 root 拥有且其他用户不可写（Linux `/opt`、macOS
`/Library/PrivilegedHelperTools`、Windows Program Files）。从备份恢复数据后目录属主可能变成
普通用户，此时助手会拒绝安装，界面提示执行 `chown`，**WeQ 不代改系统目录**。

::: warning 助手不改系统保护

它不修改 SIP、不修改 `/proc/sys/kernel/yama/ptrace_scope`、不碰 QQ 文件。macOS 的 SIP 与
Windows 的 Npcap 依赖照旧生效，长期授权不能绕过它们。

:::

## 五、发布通道

| 通道 | 编译条件 | 标识 |
| --- | --- | --- |
| 正式 | 带 `BUILD_TIMESTAMP` | `app.weq.authorization` |
| 开发 | `build-authorization-helper.mjs --development`（清掉发布戳） | `app.weq.authorization.dev` |

通道在**编译时**固定，不接受客户端声明或运行时切换；服务、目录、socket / pipe、安装锁与
用户记录全部按通道隔离。开发宿主可用 `WEQ_AUTHORIZATION_HELPER_PATH` 指向开发助手，正式
安装版忽略这个覆盖。

发布时只上传二进制与最小清单（`authorization-<platform>.json`），不含源码、日志、调试符号。
清单缺 `sha256` / `size` 时**不允许降级成无校验下载**。

## 六、代码位置

| 位置 | 内容 |
| --- | --- |
| `packages/native/authorization.mjs` | 版本常量、清单校验、契约校验 |
| `apps/desktop/src/shared/long_term_authorization.ts` | IPC 桥类型与状态枚举 |
| `apps/desktop/src/main/index.ts` | 状态查询 / 安装 / 撤销的宿主实现 |
| `apps/desktop/src/renderer/src/components/settings/LongTermAuthorizationSection.tsx` | 设置页 UI |
| `apps/desktop/src/renderer/src/lib/authorizationError.ts` | 助手英文 bail → 用户可照做的中文说明 |
| `scripts/check-authorization-helper.mjs` | 打包后的体积 / 内容校验 |

## 七、验证边界

合成测试覆盖协议、进程身份变化、跨用户拒绝、连接所有权、断开清理、撤销、过期与输入上限，
**不访问真实 QQ**。系统安装、跨用户、注销 / 重启、Npcap、签名与卸载需要在三端真机各自验收；
本地接入通过不代表已经发布或更新了 WeQ 的锚点。

## 相关

- [nt_helper.node 接口](/develop/nt-helper-interface) —— `getBuildInfo().authorizationInterface`
- [原生二进制与资源分发](./native-artifacts.md) —— `pnpm native:fetch` 的可选产物
- [维护与诊断工具](/guide/wonderful-tools) —— 抓包、密钥扫描的实际入口
- [设置总览](/guide/settings) —— 用户侧说明
