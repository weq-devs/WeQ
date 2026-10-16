# SDK 历史路径删除与远端核对

日期：2026-10-17（北京时间）。用户要求先删 SDK 路径，再获取原仓库更新，核对漫游历史能力的变化。

## 删除范围

- 产品新任务只提供 `sso30` / `sso500`，不再提供 SDK 500 条或本机桥配置。
- 删除 `NativeHistoryService` 网络/认证/配置实现、账号服务初始化与配置/探测/断开 RPC、SDK 批量派发分支，以及 `resources/native-history-plugin` 桥插件。
- 根构建命令不再提供 SDK 独立运行时构建入口。既有独立研究源码、样本和统计记录属于历史研究现场，未删除、运行或继续建设。
- 旧任务的 `native500` / `nativeBinding` 仅为解析原断点保留；新建和续作均明确拒绝，UI 禁用继续/重试。断点 hash、在途窗口和请求计数不迁移，不静默降级成 SSO。
- `native_gap_msg` 既有缓存及本机私有配置文件不删除。仅将旧消息显示投影拆到无网络能力的 `native_history_projection.ts`，保证离线时间线与导出仍能读取同 seq 不同 ID、未知元素和原始 JSON。

## 远端证据

已执行 `git fetch origin`，目标为原仓库 `H3CoF6/WeQ`。本次取得 `origin/dev=c4d557b5`，`origin/main=6df0b017`，新增版本标签 v2.0.4/v2.0.5。没有推送。

与本地基点相比，远端 29 个新增提交、158 个变动文件，涉及 OCR、导出、分词和原生组件等。存在与当前未提交代码重叠的文件，因此本轮仅获取并核对差异，没有直接合并或改写本地历史。

相关变化：

1. `9c2d30f5` 在 `packages/protocol/src/msg/get-history.ts` 给 `GetGroupHistory` / `GetC2cHistory` 明确设置 `needSign=false`，修复白名单外命令额外携带签名；没有增加新的历史请求命令或放大窗口。
2. `720d1915` 将 `native/pinned.json` 指向 `nt-helper-20261016-8353f83`，提交说明为 SSO `dataFlag=1` 应答体解压。此为远端构建的声明，本轮未下载替换本机 native/装扮资源，也未独立验证该构建或它与本地额外能力探测的兼容性。
3. 在所取远端版本中，没有 `roaming_backfill.ts` / `gap_history.ts` 的新增改动，没有找到新的单包 500 条接口，也没有本地 `sso500` 聚合实现的上游替代品。不能从本次未找到推断后续一定没有。

## 验证与生效

针对删除新增旧任务拒绝/不降级及旧缓存读出测试，保留纯协议聚合、普通 SSO、任务恢复与缓存导出回归。测试不调用真实 QQ，不读真实缓存或私有桥令牌。

本轮结果：

- 删除专项 49 项通过（任务 28、纯协议 18、旧缓存投影 3），包含旧 SDK 任务拒绝新建/续跑、不改 hash 和在途窗口、不静默降级，以及超过 2000 条旧缓存导出。
- 非 Rust 工作区测试命令通过：platform 23、codec 129、protocol 405（另 1 项既有 todo）、db 114、service 952；Web 认证与 HTTP 测试均通过。桌面另跑 5 文件、50 项回归通过。
- 全仓 Biome lint 与 `pnpm -r typecheck` 通过；改动文件 Biome 和 `git diff --check` 通过。
- `pnpm ci:local --no-daemon` 未全绿：格式检查命中本轮未改动的独立研究目录中 4 个文件；递归 test 仍会调用 daemon 的 `cargo test`，而当前没有 cargo，导致该步骤提前退出。因此另跑排除 daemon 的工作区测试，未放宽检查规则或格式化研究现场。
- 实际 React 界面合成验收通过 8 组（群/私聊、1280/390 宽、深/浅色），另含 2 个组件升级状态和 1 个旧 SDK 任务。验证没有 SDK 选项或桥配置、SSO 默认/可选项保留、旧 SDK 任务继续按钮禁用且可取消/移除。已人工检查桌面默认页和窄屏旧任务警告截图。自启 QA 浏览器正常关闭，临时夹具清理；未使用真实账号。

本轮包含 main/service/RPC 改动，完整生效需重启开发版 WeQ，仅 renderer HMR 不足。QQ 无需重启。未启动、停止或部署 WeQ/QQ，未读取或修改外盘，未安装 native。

## 后续实际合并

用户随后明确要求 merge。已再次 fetch 并执行 `git merge --no-edit origin/dev`，生成合并提交 `87eb31a2`，包含原仓库 `c4d557b5` 及此前本地 3 个提交；未 rebase、强推或推送。前文“未合并”描述的是此前核对阶段，不代表当前状态。

合并前临时 stash 包含未跟踪文件。恢复时仅 CHANGELOG 发生文本冲突，已保留上游已发布条目及 Unreleased 原条目，把本地 SDK 删除说明追加在 Unreleased 末尾。其余重叠文件自动合并。34 个未跟踪文件逐项 blob hash 一致，23 个未与上游重叠的已修改/删除文件逐项一致；5 个与上游重叠的文件为 CHANGELOG、app_context、account router、native types 和 service exports。旧 SDK 执行入口仍删除，纯协议改动保留，原未提交改动恢复为未提交状态。

依赖已执行 `pnpm install --frozen-lockfile`，使用原锁定 pnpm 12.8.1；新增 13 个包，onnxruntime-node 下载约 113.5 MB，不下载 OCR 模型，不替换 nt_helper 或装扮资源。锁文件和依赖清单保持上游版本。

合并后验证：

- 全仓 lint、类型检查和 diff check 通过。
- 排除缺少 cargo 的 daemon 后，工作区测试全部通过：agentlab 10、platform 30、codec 129、protocol 434（另 1 项既有 todo）、db 114、service 1038、desktop 121；Web 认证/HTTP 测试均通过。
- `pnpm ci:local --no-daemon` 仍未全绿，原因仍是先前 4 个未修改研究文件的格式，以及递归测试会调用缺少 cargo 的 daemon；没有通过跳过断言、改规则或删除研究文件规避。
- 原仓库历史请求 `needSign=false` 修复和 native 新锚点已进入本地源码。仅合并源码不代表新 native 已安装或 sso500 已完成新的真机验收。

开发版需重新启动以加载合并后的 main/service；本轮没有启动或退出 QQ/WeQ，没有安装 App 或推送远端。
