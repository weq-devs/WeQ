# native/ —— 预编译原生产物

这个目录里的东西分两类，来源和维护方式**不一样**：

| 路径 | 是否入库 | 从哪来 | 怎么更新 |
| --- | --- | --- | --- |
| `<platform>/<arch>/nt_helper.node` | **不入库** | 私仓 `H3CoF6/nt_helper`（Rust/napi-rs）构建后发布到公开仓 [`H3CoF6/nt_helper_release`](https://github.com/H3CoF6/nt_helper_release) | `pnpm native:fetch`（dev）/ release 流水线打包前自动取 |
| `<platform>/<arch>/ninebird/*` | 入库 | 同一个私仓的 NineBird 构建，手工同步 | 手工换成新构建再提交 |

## 布局约定（加载器与 nt_helper 内部都按这个找文件）

```
native/<platform>/<arch>/           platform ∈ {win32, linux, darwin}
  nt_helper.node                    ← 不入库
  ninebird/                         ← 入库（NineBird.node / NineBirdHook.dll /
                                       ninebird_addon.node / ninebird_launcher.so / qqnt.json）
```

`nt_helper.node` 会从自己所在目录往上找 `../../../resources/dress/<bubble|widget|font>.dat`，
也可以被 `NT_HELPER_DRESS_DIR` 覆盖（见 nt_helper 的 `src/dress.rs`）。

## 为什么 nt_helper.node 和*.dat 必须从同一个版本取

装扮资源 `.dat` 是用 AES 加密的，密钥由构建 commit 派生（`DRESS_KEY_SEED`）并**烘焙进
`.node`**。跨版本混用 → 装扮离线查询直接返回 `null`（退化到在线协议兜底，离线环境就没了）。
所以 `pnpm native:fetch` 永远从同一个 release tag 里成对取 `.node` 和 `.dat`，
`native/.installed.json` 记着当前装的是哪一份，`pnpm native:check` 用来比对。

## 有效期

CI 构建的 `.node` 带 `BUILD_TIMESTAMP`，**满 30 天失效**（`getInitStatus()` 返回 `-1`）。
本地 `cargo`/`napi` 自己编的构建不带时间戳、不校验有效期，但那份的装扮资源也只有本机构建
产物能用。所以 dev 侧隔一段时间重新 `pnpm native:fetch` 一次是正常的，不是出问题了。

细节见 [`docs/develop/native-artifacts.md`](../docs/develop/native-artifacts.md)。
