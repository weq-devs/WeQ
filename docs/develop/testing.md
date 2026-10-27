# 测试约定

本机精简范围与实际复核结果见 [离线测试精简与反馈验证](./test-feedback-20261025.md)。

| 层 | 位置 | 要真 QQ 吗 | 进 CI 吗 | 干什么用 |
|---|---|---|---|---|
| **单测** | `packages/*/test/*.test.ts`、`apps/desktop/test/*.test.ts` | 否 | ✅ `pnpm test:fail-fast` | 离线、可重复、有断言 |

---

## 单测 `test/`

vitest 跑，**不许碰 QQ 数据库、不许联网**。各 Vitest 包声明 `test: vitest run`；
Web 服务端使用 `tsx` 执行离线断言。数据用抓包/dump 出来的黄金样本硬编码在文件里；
需要 DB 行为的用 `@weq/testkit` 的 `createSqliteStub()`（node:sqlite 假绑定）对
**明文 SQLite 夹具**跑真的 src 代码路径。

```bash
pnpm test                        # 全量收集失败，包并发 2、每包最多 2 个 worker
pnpm test:fail-fast              # 全量范围，首个失败后尽早停止排队测试（CI 使用）
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

## 样式浏览器回归

`apps/desktop/test/browser/run-style-consistency.mjs` 使用真实渲染组件和样式、合成数据及
离线 tRPC 替身，阻止外部网络请求；验证消息卡片、灰条、闪传选择框、群精华和空间/频道入口。
覆盖深浅模式、跟随系统、自定义主题色、六种背景及桌面/窄屏，检查实际计算样式、对比度、
标题栏作用域和横向溢出。此项需按需手动运行，不属于 Vitest 门禁。

```bash
node apps/desktop/test/browser/run-style-consistency.mjs
```

复用已安装的 Playwright。模块不在默认解析路径时，用 `WEQ_PLAYWRIGHT_IMPORT` 指定入口；
`WEQ_BROWSER_EXECUTABLE` 可指定已有 Chromium 浏览器，`WEQ_STYLE_ARTIFACTS` 可指定截图目录。
脚本结束后会关闭自己创建的浏览器和测试服务，不使用真实 QQ 数据。

会话进入与下沿保持回归使用真实 ChatPane 和意图感知组件，合成延迟结果，覆盖短列表与
虚拟长列表、深浅色、桌面与窄屏、自动跟随开关、异步增高和窗口缩小；主动向上滚动后
必须保留阅读锚点。Playwright 与浏览器路径沿用上面的环境变量。

```bash
node apps/desktop/test/browser/run-conversation-entry.mjs
```

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
