# native/ —— 预编译原生产物

本目录保存版本锚和本机下载的原生产物；二进制不入库：

| 路径 | 是否入库 | 从哪来 | 怎么更新 |
| --- | --- | --- | --- |
| `<platform>/<arch>/nt_helper.node` | **不入库** | 私仓 `weq-devs/nt_helper`（Rust/napi-rs）构建后发布到公开仓 [`weq-devs/nt_helper_release`](https://github.com/weq-devs/nt_helper_release) | `pnpm native:fetch`（取 `pinned.json` 锚定的 tag；dev）/ release 流水线打包前自动取 |
| `<platform>/<arch>/weq-authorization-helper[.exe]` | **不入库** | 同一私有 native 仓构建，沿用 native release 清单分发 | 清单包含助手时由 `pnpm native:fetch` 获取；桌面 release 强制校验，Web 包排除 |
| `pinned.json` | 入库 | 已验证 native release 的版本锚 | 对同一明确 tag 验证后使用 `--write-pin` 更新 |
| `.installed.json` | **不入库** | fetch 脚本记录本机安装的 tag 与资产校验信息 | fetch 自动维护 |

## 布局约定（加载器与 nt_helper 内部都按这个找文件）

```
native/<platform>/<arch>/           platform ∈ {win32, linux, darwin}
  nt_helper.node                    ← 不入库
  weq-authorization-helper[.exe]
                                    ← 不入库；清单包含时获取
```

NineBird 注入链与 `packages/ninebird` 已移除，不再构建或同步 `ninebird/` 目录；
账号登录取密钥使用现有纯协议路径，在线实例能力另走 attach。长期授权助手的管理、
开发通道与发布边界见[长期授权集成](../docs/develop/long-term-authorization-20261026.md)。

`nt_helper.node` 会从自己所在目录往上找 `../../../resources/dress/<bubble|widget|font>.dat`，
也可以被 `NT_HELPER_DRESS_DIR` 覆盖（见 nt_helper 的 `src/dress.rs`）。

## 为什么 nt_helper.node 和*.dat 必须从同一个版本取

装扮资源 `.dat` 是用 AES 加密的，密钥由构建 commit 派生（`DRESS_KEY_SEED`）并**烘焙进
`.node`**。跨版本混用 → 装扮离线查询直接返回 `null`（退化到在线协议兜底，离线环境就没了）。
所以 `pnpm native:fetch` 永远从同一个 release tag 里成对取 `.node` 和 `.dat`，
`native/.installed.json` 记着当前装的是哪一份，`pnpm native:check` 用来比对。

## 版本锚（`native/pinned.json`）

`pnpm native:fetch` 默认取的是 `native/pinned.json` 里锚定的 tag，不是 latest —— WeQ 的代码
是照着某一份 native 构建写的，一直跟 latest 漂会在"代码已经用到新字段、而本地那份还是旧
的"时候静默降级。升级锚点先确定明确 tag，对该 tag 使用
`pnpm native:fetch --version <tag> --require-fresh --require-authorization --verify` 验证；
确认后对同一 tag 追加 `--write-pin` 并提交锚文件，不提交二进制。细节见
[`docs/develop/native-artifacts.md`](../docs/develop/native-artifacts.md)。

## 有效期

CI 构建的 `.node` 带 `BUILD_TIMESTAMP`，**超出有效期后失效**（`getInitStatus()` 返回 `-1`）。
有效期长度只在 nt_helper 的 Rust 里定义一处，二进制通过 `getBuildInfo()` 自报
`buildTime` / `expireTime`；`pnpm native:fetch` 会把这两个时间写进 `pinned.json`。
本地 `cargo`/`napi` 自己编的构建不带时间戳、不校验有效期，但那份的装扮资源也只有本机构建
产物能用。反复执行默认 fetch 仍会获取同一锚定 tag，不会延长有效期；
锚点过期或临近过期时，需要验证更新的构建并显式升级锚点。

细节见 [`docs/develop/native-artifacts.md`](../docs/develop/native-artifacts.md)。

## SSO 历史响应

历史拉取已统一为单次最多 30 个 seq 的 SSO 小窗，不再提供 SDK 或独立的 `sso500` 聚合通道。
较大的 SSO 响应可能压缩；上游已将支持解压的构建纳入 `native/pinned.json`。统一路径不依赖
额外实验能力导出，不把缺少该导出误当作不能收发 SSO。
源码更新不代表本机组件已替换；更新仍须成对取 native 与装扮资源，并完整重启 WeQ。
任务兼容、缓存和验收边界见 [SSO 路径统一](../docs/develop/unified-sso-history-20261017.md)。
