# native/ —— 预编译原生产物

本目录保存版本锚和本机下载的原生产物；二进制不入库：

| 路径 | 是否入库 | 从哪来 | 怎么更新 |
| --- | --- | --- | --- |
| `<platform>/<arch>/nt_helper.node` | **不入库** | 私仓 `weq-devs/nt_helper`（Rust/napi-rs）构建后发布到公开仓 [`weq-devs/nt_helper_release`](https://github.com/weq-devs/nt_helper_release) | `pnpm native:fetch`（默认只取 native）/ release 流水线打包前自动取 |
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
开发通道与发布边界见[长期授权集成](../docs/develop/long-term-authorization.md)。

`nt_helper.node` 保留从自己所在目录往上找 `../../../resources/dress/<bubble|widget|font>.dat` 的旧布局，
也支持 `NT_HELPER_DRESS_DIR` 覆盖（见 nt_helper 的 `src/dress/mod.rs`）。当前应用由共享装扮服务管理按需下载的索引，
查询时指向宿主缓存；本地源码开发仍使用构建生成的配套资源。

## 为什么仍须匹配 native 密钥来源

装扮资源 `.dat` 是用 AES 加密的，密钥由构建 commit 派生（`DRESS_KEY_SEED`）并**烘焙进
`.node`**。跨版本混用 → 装扮离线查询直接返回 `null`（退化到在线协议兜底，离线环境就没了）。
现阶段仍必须匹配密钥来源，但不再默认一起下载或打包。
应用按 `resources/dress/index-manifest.json` 从独立资源仓的明确 Release 按类别下载索引到全局缓存；
清单的 `nativeCommit` 与 `pinned.json` 一致。`pnpm native:fetch --with-dress` 可显式取旧配套资源。
`native/.installed.json` 记录安装文件，默认 `native:check` 不检查已改为可选的旧索引。

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
源码更新不代表本机组件已替换；升级 native 后须完整重启 WeQ，并确认固定索引清单与其密钥来源一致。
三类索引由应用按需获取，不再要求手动成对下载，也不随安装包携带。
任务兼容、缓存和验收边界见 [SSO 路径统一](../docs/develop/unified-sso-history-20261017.md)。
