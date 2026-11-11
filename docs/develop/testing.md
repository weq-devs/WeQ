# 测试约定

本机精简范围与实际复核结果见 [离线测试精简与反馈验证](./test-feedback-20261025.md)。

| 层 | 位置 | 要真 QQ 吗 | 进 CI 吗 | 干什么用 |
|---|---|---|---|---|
| **单测** | `packages/*/test/*.test.ts`、`apps/desktop/test/*.test.ts` | 否 | ✅ 全量分片，见下文 | 离线、可重复、有断言 |

---

## 单测 `test/`

vitest 跑，**不许碰 QQ 数据库、不许联网**。各 Vitest 包声明 `test: vitest run`；
Web 服务端使用 `tsx` 执行离线断言。数据用抓包/dump 出来的黄金样本硬编码在文件里；
需要 DB 行为的用 `@weq/testkit` 的 `createSqliteStub()`（node:sqlite 假绑定）对
**明文 SQLite 夹具**跑真的 src 代码路径。

```bash
pnpm test                        # 全量收集失败，包并发 2、每包最多 2 个 worker
pnpm test:fail-fast              # 本地全量范围，首个失败后尽早停止排队测试
pnpm test:changed                # 日常反馈：Vitest 只跑 Git 改动相关测试，Web 仍跑完整服务端断言
pnpm --filter @weq/codec test     # 单个包
pnpm --filter @weq/codec test:watch
pnpm --filter @weq/desktop test   # 桌面端主/渲染进程的纯逻辑单测
```

`apps/desktop` 的单测默认跑在 **happy-dom** 环境（`apps/desktop/vitest.config.ts`），
因为渲染进程的投影器直接吃 `DOMParser`。不依赖 DOM 的主进程、协议边界和纯逻辑测试，
在文件第一行声明 `// @vitest-environment node`，避免逐文件初始化浏览器模拟环境。
环境以实际调用路径为准，不能仅凭文件名判定；间接使用 DOM 的解析器仍保留 happy-dom。
桌面端使用线程池，保留 Vitest 默认的逐文件隔离，不共享 mock 和模块状态。

`test:changed` 只是开发阶段的快速反馈，不替代 CI 全量范围；也可在对应包运行
`pnpm --filter @weq/desktop test --changed=dev` 指定对比基准。
`ci:local` 默认继续汇总各步骤，`ci:local --fail-fast` 同时启用单测内部的失败即停。
各包单测直接读取工作区源码，不依赖其他包预先构建；根入口不按包依赖排序，
避免无谓串行等待，以及上游测试失败后下游测试未执行。完整模式还会继续运行其余包。

## CI 分片

Actions 将 desktop 拆为 6 片、service 拆为 2 片，使用 Vitest 的
`--shard=i/n` 入口，各自最多 2 个 worker；其余包（包括 Web 服务端断言）在独立任务中完整运行。
desktop 的自定义 sequencer 按文件成本从高到低，把文件放入当前总成本最低的一片，
每片内也先执行高成本文件；service 保留 Vitest 原生分片。不指定 `--shard` 的本地运行
仍使用 Vitest 默认排序。
不减少测试范围、不关闭文件隔离、不重试掩盖失败。矩阵不因某片失败取消其余片，
最终由稳定名称 `test` 汇总门禁检查全部任务；失败、取消或意外跳过均不能通过。
本地 `pnpm test` / `test:fail-fast` 保持原有的低资源入口，不启动多片并发。

可单独复现某片：

```bash
pnpm --filter @weq/desktop test --shard=1/6 --maxWorkers=2 --minWorkers=1
pnpm --filter @weq/service test --shard=1/2 --maxWorkers=2 --minWorkers=1
node --test scripts/test-ci.test.mjs
```

每片输出用例 JSON 报告和 `test-timings.json` 文件成本报告，保存 7 天，
Actions 步骤摘要列出失败文件及用例执行时间最长的文件。
报告中的文件起止时间不等于整个分片耗时；验收 2～3 分钟目标时，以实际 Actions
完整运行的墙钟耗时为准，同时检查排队和依赖安装，不用本机分片时间直接宣称达标。

desktop 的成本基线在 `apps/desktop/test/ci-timings.json`，单位为毫秒，
包含 worker 准备、环境初始化、模块收集、setup 和用例执行，不能只用用例时间替代。
所有 runner 读取同一份已提交基线，保证分配一致；新增文件使用已知成本的中位数，
删除文件的旧记录不参与分配，不因缺少记录跳过测试。成本总和不是并行运行的墙钟时间。
初始基线来自本机双 worker 实测，跨平台表现需以 Linux Actions 为准。
其中两个仅 macOS 执行的原生测试不记录本机成本，仍完整参与分片，
用中位数估计它们在 Linux 上的收集成本，避免原生签名等开销影响 Linux 的分配。

更新基线时，在空闲环境运行完整 desktop 测试并输出成本报告，确认测试结果和覆盖范围后，
用报告替换基线并重新运行 `node --test scripts/test-ci.test.mjs`；也可合并同一提交所有
desktop 分片的 `test-timings.json` 中的 `files`，不能只取某一片当完整基线。

```bash
mkdir -p tmp
WEQ_TEST_TIMINGS="$PWD/tmp/desktop-timings.json" pnpm --filter @weq/desktop test \
  --maxWorkers=2 --minWorkers=1 --reporter=default \
  --reporter=../../scripts/test-timing-reporter.mjs
```

## CI 类型检查

类型检查使用四组独立 runner：桌面主进程、桌面渲染、Web 服务端、`packages/*`。
各组失败不会取消其他组，稳定名称 `typecheck` 汇总全部结果；失败、取消或跳过均不能通过。
根目录 `pnpm typecheck` 保留原来的本地入口，不在本机同时启动四组。

CI 仅缓存 `.tsbuildinfo` 编译图，不缓存通过结论，每次仍执行所有分组的 `tsc --noEmit`。
缓存按系统、架构、Node 主版本、分组、锁文件、workspace 清单和 TS 配置隔离，
每个提交保存一份，通过同配置前缀复用上一轮状态。缓存缺失时执行正常冷检查，
源码变化由 TypeScript 增量失效机制重新检查；编排测试还实际编译依赖变化、文件删除和
编译选项收紧的反例，避免缓存掩盖错误。

## 样式浏览器回归

`apps/desktop/test/browser/run-style-consistency.mjs` 使用真实渲染组件和样式、合成数据及
离线 tRPC 替身，阻止外部网络请求；验证消息卡片、灰条、闪传选择框、群精华和空间/频道入口。
覆盖深浅模式、跟随系统、自定义主题色、六种背景及桌面/窄屏，检查实际计算样式、对比度、
标题栏作用域和横向溢出。此项需按需手动运行，不属于 Vitest 门禁。

```bash
node apps/desktop/test/browser/run-style-consistency.mjs
```

联系人关系回归使用 `node apps/desktop/test/browser/run-contact-relationship.mjs`，验证真实名片、列表和搜索结果的关系标识、长名称布局与主题取色，覆盖深浅色／跟随系统、六种背景和桌面／窄屏。沿用上述 Playwright 与浏览器路径变量，可用 `WEQ_RELATIONSHIP_ARTIFACTS` 指定截图目录；测试仅使用合成联系人，不连接 QQ。

复用已安装的 Playwright。模块不在默认解析路径时，用 `WEQ_PLAYWRIGHT_IMPORT` 指定入口；
`WEQ_BROWSER_EXECUTABLE` 可指定已有 Chromium 浏览器，`WEQ_STYLE_ARTIFACTS` 可指定截图目录。
脚本结束后会关闭自己创建的浏览器和测试服务，不使用真实 QQ 数据。

消息装扮加载回归使用 `node apps/desktop/test/browser/run-decoration-readiness.mjs`，复用真实消息装扮 Hook 与聊天样式。覆盖 390/1200px、深浅主题及双方消息：延迟字体与未缓存底图时消息始终可见；让图片预解码永不完成，检查 48 行首次提交就应用本地气泡，截图像素中确实出现底图，并报告与未缓存场景的首次提交耗时。沿用上述 Playwright 与浏览器路径变量，可用 `WEQ_DECORATION_ARTIFACTS` 指定截图目录。脚本只在这个故意挂起字体的夹具中跳过 Playwright 截图前的字体等待。资源来自合成 PNG 和仓库已有字体，不连接 QQ。

组件风格与独立密度使用 `node apps/desktop/test/browser/run-component-appearance.mjs`，
覆盖 QQ NT 默认与经典／简约／复古风格、两种密度、深浅色、六种背景和桌面／窄屏，检查经典样式不被覆盖、各套风格的形态差异，以及键盘选择、刷新恢复、
跟随系统和真实会话虚拟列表行高。复古额外检查分段选项、功能页导航和搜索框、任务浮层、提示框，以及真实 ChatPane 的消息气泡、头像与主导航；整页模式不继承弹窗外框和阴影。Playwright 与浏览器路径沿用上述变量，
截图目录由 `WEQ_APPEARANCE_ARTIFACTS` 指定。

会话进入与下沿保持回归使用真实 ChatPane 和意图感知组件，合成延迟结果，覆盖短列表与
虚拟长列表、深浅色、桌面与窄屏、自动跟随开关、异步增高和窗口缩小；主动向上滚动后
必须保留阅读锚点。Playwright 与浏览器路径沿用上面的环境变量。

```bash
node apps/desktop/test/browser/run-conversation-entry.mjs
```

HTML 导出图片比例可运行 `node apps/desktop/test/browser/run-export-image-ratio.mjs` 回归，覆盖聊天图片、说明文字、表情、转发、Markdown、空间单图/多图以及桌面/窄屏与深浅色；仅使用内联合成图片，不联网、不读取 QQ。Playwright 与浏览器路径沿用上面的环境变量，`WEQ_IMAGE_RATIO_ARTIFACTS` 可指定截图目录。

## 原生文本编辑菜单

`node scripts/smoke-edit-context-menu.mjs` 使用当前安装的 Electron 启动独立离线测试窗口，
覆盖普通、搜索、密码、数字、多行及富文本输入框的真实右键事件，只读输入框和消息区互不接管，
并检查原生复制/剪切命令的 DOM 事件、文本撤销/重做/全选/删除及深浅色系统菜单。粘贴入口与状态由单测检查，
不依赖用户当前剪贴板内容执行原生粘贴。测试不连接 QQ，
不使用真实应用资料，拦截剪贴板事件以避免读写用户剪贴板；完成后关闭测试进程并删除临时资料。

## 合并与夹具

- 同领域、同依赖且没有模块 mock 的小测试可合并成一个文件，各自的 `describe` 保留局部夹具和 hook 作用域，减少重复 worker 启动和依赖加载。
- 不合并具有不同 `vi.mock` / `vi.hoisted` 契约的文件，避免 mock 提升后互相污染；不关闭隔离来提速。
- 同一设置面板中独立开关的默认值、保存、恢复、失败和禁用检查可按阶段共享挂载；断言携带开关名称，接口映射仍逐项校验。不同生命周期、异步竞争和安全边界继续单独测试。
- 配置持久化夹具复用 `packages/service/test/support/user_config.ts`：每个测试创建独立临时目录，结束后清理；旧配置通过原始 JSON 输入，不调用规范化函数生成预期值。
- 不为减少测试数量删掉协议黄金样本、真实 SQLite 查询、迁移反例或失败恢复；不缩短超时、放宽断言或跳过测试。

写的时候注意两件事，都是真踩过的坑：

- **断言别复制常量的字面量**。`scupdate.test.ts` 曾把 QQ 版本号写死成 `'8.8.17.5770'`，
  src 里升到 `9.3.5.37250` 后测试就成了假警报。要断言就 import 那个常量。
- **拿「未声明字段」举例时挑个远离已用区间的 tag**。`registry.test.ts` 曾用 tag 47608 当
  未知字段，后来 47608 被建模成 `faceFlag47608`，测试就炸了。

---

[← 返回开发者入口](./index.md)
