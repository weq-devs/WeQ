# AGENTS.md

给在本仓库里干活的 AI 编码代理（Codex / Claude Code / 其他）看的作业说明。
人写的权威文档是 [CONTRIBUTING.md](./CONTRIBUTING.md) 和 [docs/](./docs/README.md)；
本文与它们冲突时，以那两份为准。

## 0. 先认路

WeQ 是 QQ NT 本地聊天记录的解密 / 导出 / 查看 / 年度报告工具，pnpm workspace monorepo：

| 路径 | 是什么 |
| --- | --- |
| `apps/desktop` | Electron 桌面端（主进程 / 渲染进程 / 预加载） |
| `apps/web` | 机器人 WebUI |
| `packages/*` | protocol、db、codec、service、bot、native、testkit 等库 |
| `packages/daemon` | Rust 守护进程 |
| `native` | nt_helper 原生产物与 pinned 清单（二进制不入库） |
| `docs/` | 文档中心：`guide` 用户向、`develop` 开发向、`principles` 原理、`database` 表结构 |

- Node ≥ 22.12.0；包管理器只能用 **pnpm**（锁定 `pnpm@12.8.1`），别用 npm / yarn，会污染 `pnpm-lock.yaml`。
- 新克隆里没有原生产物，先 `pnpm native:fetch`，否则桌面端跑不起来。

## 1. 分支：一切以 dev 为基准

- **所有改动都以 `dev` 为基准**。落点是 `dev` 还是特性分支，看这次是**提 PR** 还是**直接 push**：
  - **准备提 PR**（默认，尤其非维护者 / 大改动）：从最新的 `dev` 拉特性分支，在上面提交，PR 的 base 也是 `dev`。
  - **直接 push**（维护者自己、小改动、懒得起 PR）：可以直接 commit 到 `dev` 然后 push，不用非开分支。
- `main` 是发布分支，只接受来自 `dev` 的合并，**不要**基于 `main` 开分支，也不要直接对 `main` 提 PR 或提交。
- 走 PR 时分支名 `类型/简短描述`，小写短横线：`feat/linux-adaptation`、`fix/anti-recall-graytip`、`refactor/test-config-cleanup`。

```bash
# 走 PR
git checkout dev && git pull
git checkout -b feat/your-feature

# 直接 push：跳过上面这步，在当前 dev 上改完直接 commit + push
```

- Commit 用 [Conventional Commits](https://www.conventionalcommits.org/)：`feat` / `fix` / `refactor` / `docs` / `style` / `test` / `chore` / `perf`，描述可以用中文。
- 一个 PR 只做一件事，别把不相关的改动塞进同一个 PR。

## 2. 本地检查：按需跑，别每次都跑全量

**为了省时间，push 之前不用跑全量 `pnpm ci:local`。** 它把 `.github/workflows/ci.yml` 的门禁在本地按同样顺序复刻一遍（lint / format / typecheck / 单测 / Rust 三项），整轮很慢；日常改动跑一下**和改动相关的那一两项**就够，最终以 CI 结果为准。

- **CI 跑在 Linux 上**，Windows 本地跑红**不一定**是真问题（路径、换行、大小写、原生模块等平台差异都可能误报）。Windows 本地红的项，先判断是不是平台差异，别急着改代码。
- 改了 TS / 前端：`pnpm lint`、`pnpm typecheck` 通常就够；只动了某个包可以 `pnpm --filter @weq/<pkg> test`。
- 改了格式就 `pnpm format`（或 `pnpm lint:fix`）刷一遍，别手写对齐。
- 动了 `packages/daemon`：在 `packages/daemon` 下跑 `cargo fmt --check`、`cargo clippy --all-targets --all-features -- -D warnings`、`cargo test`。
- 发版前 / 大改动 / 心里没底时，再跑全量：

```bash
pnpm ci:local             # 全量门禁；不 fail-fast，跑完给一张汇总表
pnpm ci:local --fix       # 先 pnpm format + lint:fix 刷平格式再跑门禁
pnpm ci:local --full      # 额外跑 web 打包冒烟（≈ CI 的 build-web）
pnpm ci:local --no-daemon # 本机没 Rust 时跳过 cargo 三项
```

- 真跑红的检查就如实报告失败项和报错。**不要**为了让门禁变绿去放宽规则、加 `// biome-ignore`、塞 `any` / `@ts-ignore`、跳过或删除测试。
- 打包链路（electron-builder）不在 PR 门禁里。改到它时用 `pnpm --filter @weq/desktop build:unpack` 本地验一遍。

## 3. Changelog：新功能 / bug 修复必须写

`CHANGELOG.md` 是版本更新的**唯一内容源** —— 推文、QQ 群通知、Release 说明、系统通知摘要全从它取，改一处四端一致。

1. **新功能、bug 修复、以及用户能感知到的行为变化（性能、稳定性、界面）都要写进去。** 纯内部改动（重构、单测、CI、内部文档）可以不写。
2. 开发中的改动**追加到文件末尾的 `## Unreleased - 进行中` 章节**。
   **如果文件末尾没有这个章节，先把它补上**（放在最后一个已发布版本之后），再往里加条目。
3. 一句话一条 bullet，写「用户/开发者能看出什么变化」，不要写实现细节；章节里的**第一条 bullet 会被当作通知摘要**，短一点。
4. 只追加自己的条目：**不要改已发布版本的章节**，发版时由维护者把 `Unreleased` 改成 `## <版本号> - <日期>`。
5. 同一功能的多个点可以聚成一条 bullet + 子列表（参考 2.0.4 的空间更新）。
6. **按「大事件」合并，别按 commit 罗列。** 一个 `feat: xxx` 加上随后一堆 `fix: xxx` 的修补，是**同一件事**，Changelog 里只写这条特性本身，**不要**把「修复了 xxx 特性的 bug」逐条列出来——用户看到的是「有了什么」，不是你的开发过程。只有独立于该特性的、别人能单独感知到的 bug 修复才单独写一条。

```markdown
## Unreleased - 进行中
- **空间继续增强**：
    - 新增深度相册浏览与媒体预览
    - 空间分页支持限流配置
- 修复字体缓存升级后不重解
```

## 4. 动手前：先查有没有现成的

**在这个仓库里，「重复造轮子」比「写得不够漂亮」严重得多。**

- 先搜再写：用 `rg <关键词>` 找现有实现、工具函数、协议定义。同名能力通常已经躺在 `packages/service`、`packages/protocol`、`packages/db`、`packages/codec` 里了。
- 涉及 QQ 侧能力，先看 [docs/develop/nt-helper-interface.md](./docs/develop/nt-helper-interface.md)（原生模块能力总览）和 [docs/develop/](./docs/develop/) 下的专题文档，别绕过已有接口自己碰内存 / 数据库。
- 表结构和字段看 [docs/database/](./docs/database/)，加解密原理看 [docs/principles/](./docs/principles/)。
- 找不到现成实现再动手；动手时优先复用已有的类型、常量、工具函数，不要另起一套并行抽象。
- 大改动（跨包重构、新增依赖、改协议层）先说清方案和影响面，别一次性铺开。

## 5. 前端组件：深浅模式 + 主题色都要适配

新写 / 改桌面端 UI（`apps/desktop/src/renderer`）时，**默认要同时成立**：浅色好看、深色好看、跟随设置里的主题色、在任意界面背景下都站得住。别做完浅色就交，等别人来报「深色下看不见」。

- **颜色一律走 design token，不写死。** token 定义在 `apps/desktop/src/renderer/src/styles/index.css`：一套 shadcn 风格的基础色（`--background`、`--foreground`、`--card`、`--muted`、`--border`、`--primary`、`--ring`、`--radius`），一套 WeQ 语义色（`--weq-bg-surface`、`--weq-fg-primary` / `--weq-fg-secondary` / `--weq-fg-muted`、`--weq-border-subtle` / `--weq-border-strong`、`--weq-shadow-soft` / `--weq-shadow-card`）。
  Tailwind 里直接用 `bg-background`、`text-foreground`、`text-muted-foreground`、`border-border`、`bg-primary` 这类工具类。
- **主题色用 `--weq-accent-effective`**（用户在「设置 → 个性显示 → 主题色」里挑的自定义色优先，没挑就回落到预设 `--weq-accent`）。强调色、描边、高亮、图表取色都用它；要淡一点、要半透明就用 `color-mix(in srgb, var(--weq-accent-effective) 15%, transparent)`，**不要**写死 `#0099ff` 或自己另挑一支蓝。
- **深色模式的差异要显式写覆盖**，它是独立一套值而不是浅色取反。主题钩在 `html[data-theme="dark"]` 上（`state/theme.ts` 同时 toggle `.dark` 类，两个都认），所以写 `html[data-theme="dark"] .your-class { ... }`。
- **别用 Tailwind 的 `dark:` 工具类。** 本项目的暗色钩子是 `data-theme`，`dark:` variant 只被桥接给 streamdown 用过（见 `styles/index.css` 里 `@custom-variant dark` 的注释），别处一律不生效。
- 顺带检查那些「浅色下没事、深色下就废」的写法：`rgba(255, 255, 255, …)` 遮罩、白底渐变、写死的浅灰描边、`--weq-bar-surface` 这类半透明玻璃质感栏。
- 界面背景会换掉聊天画布（`data-background`：plain / paper / grid / dots / wash / telegram → `--weq-chat-bg`）。浮层、卡片如果贴在画布上，让它跟着透出底色，别自己铺一层不透明底。
- 新样式放 `apps/desktop/src/renderer/src/styles/<功能>.css`，由对应组件 `import`（参考 `views/QzoneView.tsx`、`views/annual-report/AnnualReportView.tsx`），别一股脑塞进 `index.css`。
- `apps/web` 的独立页面（如 `src/server/login_page.ts`）不走 app 主题，用 `prefers-color-scheme` 和自己那套 `--fg` / `--card` / `--accent` 变量，**同样要给深色写一份**。
- 自验方式：浅色 / 深色 / 跟随系统切一遍，再在设置里换几个主题色（浅色系和深色系各试一个）和几款界面背景看一眼，顺手过一下系统「减少动态效果」。

## 6. 什么时候加单测

完整约定见 [docs/develop/testing.md](./docs/develop/testing.md)，要点是 vitest、**不碰真 QQ 数据库、不联网**、数据用黄金样本硬编码。

位置：`packages/*/test/*.test.ts`、`apps/desktop/test/*.test.ts`（`pnpm -r test` 会跑到）。

**必须写**：

- **修 bug**：先补一个能复现的失败用例，再改代码让它变绿（回归测试，别让同一个人踩两次）。
- 新增或修改纯逻辑：协议编解码、字段/标签映射、解析、排序/过滤/分页、时间与 hash 计算、状态机。
- 改动 `packages/db` 的 SQL 行为：用 `@weq/testkit` 的 `createSqliteStub()` 对明文 SQLite 夹具跑真实 src 代码路径。

**可以不加**：纯 UI 布局 / 样式 / 文案改动，以及只能靠真机真 QQ 验证的路径（这种在 PR 里写清怎么验的）。

写的时候注意两个真踩过的坑：

- 断言别复制常量的字面量，**import 那个常量**（曾把 QQ 版本号写死，src 升级后测试变成假警报）。
- 拿「未声明字段」举例时挑个远离已用区间的 tag（47608 后来被建模成真字段，测试就炸了）。

## 7. 代码风格与依赖

- 格式化 / lint 全交给 Biome：`pnpm format`、`pnpm lint:fix`。不要手写对齐，也不要引入 prettier / eslint 配置。
- `pnpm lint` 在 CI 里带 `--error-on-warnings`，存量告警已清零，新增的必须当场处理。
- TypeScript 严格模式；别用 `any` / `@ts-ignore` 掩盖类型问题，该补类型就补类型。
- 注释、提交信息、文档用中文，跟仓库现状保持一致。
- 加依赖前先确认现有依赖做不到；要加就只加必要的，用 `pnpm add` 更新 `pnpm-lock.yaml`，不要手改锁文件。
- 生成物和体积大的产物不入库：`node_modules`、`out`、`release`、原生产物（走 `pnpm native:fetch`）。

## 8. 文档

- 用户向的用法 / 功能说明写 [docs/guide/](./docs/guide/)。
- 开发向的设计、协议、踩坑记录写 [docs/develop/](./docs/develop/)；大改动按现有惯例加一份带日期的笔记（如 `qzone-media-grid-20261015.md`）。
- 改了对外行为 / 配置项 / 接口，顺手把对应文档一起改，别留旧描述。

## 9. 红线

- 不提交 `.env`、密钥、Cookie、抓包里的真实 uin / 好友数据；隐私数据要么脱敏要么不入库。
- 不碰 `main` 分支和 `CHANGELOG.md` 的已发布章节；不对共享分支 force push。
- 不做与任务无关的大范围重排 / 重命名 / 全仓格式化，别「顺手」改别人的代码。
- 需要产品决策的事（做不做某功能、UI 怎么摆）先问，别替用户拍板。
- 全新功能按 [CONTRIBUTING.md](./CONTRIBUTING.md) 先开 Issue 对齐方向再写代码。

## 10. 收工前自检

- [ ] 落点正确（提 PR 走特性分支、直接 push 落 `dev`），改动聚焦单一主题
- [ ] 跑过和改动相关的检查项（`pnpm lint` / `pnpm typecheck` / 相关包单测 / cargo 三项）；不要求 push 前跑全量 `pnpm ci:local`，最终以 CI 为准
- [ ] 新功能 / bug 修复已写进 `CHANGELOG.md` 的 `## Unreleased - 进行中`（没有这一节就先补上）
- [ ] 该加的单测加了，且没碰真 QQ 数据 / 网络
- [ ] 动过 UI 的话：浅色 / 深色 / 换主题色都看过一眼
- [ ] 相关类型、常量、文档同步更新
- [ ] 提交信息符合 Conventional Commits
