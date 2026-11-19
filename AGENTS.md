# AGENTS.md

给在本仓库里干活的 AI 编码代理（Codex / Claude Code / 其他）看的作业说明。
人写的权威文档是 [CONTRIBUTING.md](./CONTRIBUTING.md) 和 [docs/](./docs/index.md)；
本文与它们冲突时，以那两份为准。

## 0. 先认路

WeQ 是 QQ NT 本地聊天记录的解密 / 导出 / 查看 / 年度报告工具，pnpm workspace monorepo：

| 路径 | 是什么 |
| --- | --- |
| `apps/desktop` | Electron 桌面端（主进程 / 渲染进程 / 预加载） |
| `apps/web` | 浏览器版 WeQ，复用桌面业务界面与后端 |
| `packages/*` | protocol、db、codec、service、bot、native、testkit 等库 |
| `native` | nt_helper 原生产物与 pinned 清单（二进制不入库） |
| `docs/` | 文档中心：`guide` 用户向、`develop` 开发向、`principles` 原理、`database` 表结构 |

- Node ≥ 22.12.0；包管理器只能用 **pnpm**（锁定 `pnpm@12.8.1`），别用 npm / yarn，会污染 `pnpm-lock.yaml`。
- 新克隆直接 `pnpm dev`，自动补依赖、原生产物与必要构建；发布版／本地源码 native 来源通过 `weq.dev.json` 和不入库的 `weq.dev.local.json` 配置，见 `docs/develop/dev-startup.md`。

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

日常开发按 [测试约定](./docs/develop/testing.md#日常开发选择最小充分验证) 选择最小充分验证，已有证据足够就停止。**不要求每次改动新增测试，也不要求提交前复刻 CI**；纯文案、图标、局部样式及入口增删通常检查差异即可。CI 继续执行全量门禁。

- **CI 跑在 Linux 上**，Windows 本地跑红**不一定**是真问题（路径、换行、大小写、原生模块等平台差异都可能误报）。Windows 本地红的项，先判断是不是平台差异，别急着改代码。
- 格式／lint 优先指定修改文件；涉及类型或接口时选对应类型检查；需要回归时优先指定已有用例／文件，不因改了某包就跑整个包。
- 格式化仅处理本任务文件或片段，不为小改运行全仓 `pnpm format`／`pnpm lint:fix`。
- 发版前、跨模块大改动或明确需要全量复核时，再按影响面选择全量；不能仅因「心里没底」叠加所有检查：

```bash
pnpm ci:local             # 全量门禁；不 fail-fast，跑完给一张汇总表
pnpm ci:local --fix       # 先 pnpm format + lint:fix 刷平格式再跑门禁
pnpm ci:local --full      # 额外跑 web 打包冒烟（≈ CI 的 build-web）
```

- 独立 daemon 已移除；默认发布版 native 模式不需要 Rust 工具链，本地源码模式需要。
- 需要单独跑某一步时，等价命令：`pnpm lint`、`pnpm format:check`、`pnpm typecheck`、`pnpm -r test`；
- 真跑红的检查就如实报告失败项和报错。**不要**为了让门禁变绿去放宽规则、加 `// biome-ignore`、塞 `any` / `@ts-ignore`、跳过或删除测试。
- 打包链路（electron-builder）不在 PR 门禁里。改到它时用 `pnpm --filter @weq/desktop build:unpack` 本地验一遍。

## 3. Changelog：新功能 / bug 修复必须写

`CHANGELOG.md` 是版本更新的**唯一内容源**：Release 说明和 QQ 群通知共用正文，WeQ 助手从对应版本的更新索引读取摘要。

发版时 Release 说明和 QQ 群文案会先交给 AI 重写成「按分类、抓重点、口语化」的摘要（`scripts/release-notes.mjs`，
失败自动回退原文）。`###` 副标题和「变更规模」原样保留，只整理中间的改动条目。

1. **新功能、bug 修复、以及用户能感知到的行为变化（性能、稳定性、界面）都要写进去。** 纯内部改动（重构、单测、CI、内部文档）可以不写。
2. 开发中的改动**追加到顶部的 `## Unreleased - 进行中` 章节**。没有就先在第一个已发布版本之前补上；已发布版本由新到旧排列。
3. 一句话一条 bullet，写「用户/开发者能看出什么变化」，不要写实现细节；**第一条顶层 bullet 用作 WeQ 助手的摘要**，短一点。
4. 只追加自己的条目：**不要改已发布版本的章节**。发版时把当前 `Unreleased` 改为 `## <版本号> - <YYYY-MM-DD>`，版本与 Git tag 一致，再在上方建一个新的 `Unreleased`。
5. 同一功能的多个点可以聚成一条 bullet + 子列表。
6. **按「大事件」合并，别按 commit 罗列。** 一个 `feat: xxx` 加上随后一堆 `fix: xxx` 的修补，是**同一件事**，Changelog 里只写这条特性本身，**不要**把「修复了 xxx 特性的 bug」逐条列出来——用户看到的是「有了什么」，不是你的开发过程。只有独立于该特性的、别人能单独感知到的 bug 修复才单独写一条。
7. **别为了「好看」删信息。** AI 摘要需要素材才能抓重点，条目写得越具体，发版文案越准；觉得琐碎就合并到父 bullet，而不是不写。

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
- 表结构和字段看 [docs/database/](./docs/database/)，加解密原理看 [docs/develop/principles/](./docs/develop/principles/)。
- 找不到现成实现再动手；动手时优先复用已有的类型、常量、工具函数，不要另起一套并行抽象。
- 大改动（跨包重构、新增依赖、改协议层）先说清方案和影响面，别一次性铺开。

## 5. 前端组件：深浅模式 + 主题色都要适配

新写 / 改桌面端 UI（`apps/desktop/src/renderer`）时，**默认要同时成立**：浅色好看、深色好看、跟随设置里的主题色、在任意界面背景下都站得住。别做完浅色就交，等别人来报「深色下看不见」。

- **颜色一律走 design token，不写死。** token 定义在 `apps/desktop/src/renderer/src/styles/index.css`：一套 shadcn 风格的基础色（`--background`、`--foreground`、`--card`、`--muted`、`--border`、`--primary`、`--ring`、`--radius`），一套 WeQ 语义色（`--weq-bg-surface`、`--weq-fg-primary` / `--weq-fg-secondary` / `--weq-fg-muted`、`--weq-border-subtle` / `--weq-border-strong`、`--weq-shadow-soft` / `--weq-shadow-card`）。
  Tailwind 里直接用 `bg-background`、`text-foreground`、`text-muted-foreground`、`border-border`、`bg-primary` 这类工具类。
- **主题色用 `--weq-accent-effective`**（用户在「设置 → 常规 → 主题与背景 → 主题色」里挑的自定义色优先，没挑就回落到预设 `--weq-accent`）。强调色、描边、高亮、图表取色都用它；要淡一点、要半透明就用 `color-mix(in srgb, var(--weq-accent-effective) 15%, transparent)`，**不要**写死 `#0099ff` 或自己另挑一支蓝。
- **普通按钮默认中性，主题色只强调任务主动作。** `weq-set-btn` 为中性底色与描边，保存、提交、确认或流程核心下一步显式添加 `weq-set-btn-primary`；`weq-set-btn-soft` 保留为旧中性用法。打开工具、浏览、复制、返回、取消及普通刷新／重试不因可点击而使用主题色实底，一个独立任务区通常最多一个主按钮，也可以没有。开关开启和选中状态独立表达，不与行动层级混用；各外观、深浅主题和自定义主题色均遵循同一语义。
- **深色模式的差异要显式写覆盖**，它是独立一套值而不是浅色取反。主题钩在 `html[data-theme="dark"]` 上（`state/theme.ts` 同时 toggle `.dark` 类，两个都认），所以写 `html[data-theme="dark"] .your-class { ... }`。
- **危险按钮分两档**：只有全局恢复、永久删除整段历史、清理不可再生媒体等高风险操作用红色实底（`data-danger="solid"`）；清除已读记录、局部恢复、删除单项配置等用红色文字与图标（`data-danger="outline"`），原本有框的通用按钮可将既有描边染红，无框或透明描边的图标、工具栏按钮不因危险等级额外加框。危险及禁用状态沿用同一按钮的外观形态，不改变尺寸、圆角、描边厚度和阴影；危险色不跟随用户主题色，兼顾深浅主题、悬停与键盘焦点。各类菜单入口只标红文字和图标，不使用独立外框或红色实底。
- 危险等级由实际操作显式提供；通用确认使用 `danger` 选项，QQ 操作及菜单透传同一等级。不要按文案关键词、警告／错误提示的 `tone` 自动染红，也不要把搜索清空、选择清空、取消、关闭、返回或普通重试当作危险操作。
- **别用 Tailwind 的 `dark:` 工具类。** 本项目的暗色钩子是 `data-theme`，`dark:` variant 只被桥接给 streamdown 用过（见 `styles/index.css` 里 `@custom-variant dark` 的注释），别处一律不生效。
- 顺带检查那些「浅色下没事、深色下就废」的写法：`rgba(255, 255, 255, …)` 遮罩、白底渐变、写死的浅灰描边、`--weq-bar-surface` 这类半透明玻璃质感栏。
- 界面背景会换掉聊天画布（`data-background`：plain / paper / grid / dots / wash / telegram → `--weq-chat-bg`）。浮层、卡片如果贴在画布上，让它跟着透出底色，别自己铺一层不透明底。
- 新样式放 `apps/desktop/src/renderer/src/styles/<功能>.css`，由对应组件 `import`（参考 `views/QzoneView.tsx`、`views/annual-report/AnnualReportView.tsx`），别一股脑塞进 `index.css`。
- `apps/web` 的独立页面（如 `src/server/login_page.ts`）不走 app 主题，用 `prefers-color-scheme` 和自己那套 `--fg` / `--card` / `--accent` 变量，**同样要给深色写一份**。
- 自验按改动选择：颜色变化看受影响的深浅主题，布局变化看相关宽度，动画变化看减少动态效果；复用既有 token 的简单增删不默认切全套主题／背景或启动浏览器。只有真实渲染或交互才能判断的问题才做对应检查，不为每次 UI 修改新增 Playwright 脚本。

## 6. 什么时候加单测

完整约定见 [docs/develop/testing.md](./docs/develop/testing.md)，要点是 vitest、**不碰真 QQ 数据库、不联网**、数据用黄金样本硬编码。

位置：`packages/*/test/*.test.ts`、`apps/desktop/test/*.test.ts`（`pnpm -r test` 会跑到）。

**按风险和长期价值决定，不按「修 bug」一刀切**：先看现有测试是否已覆盖，优先修改已有用例。协议、SQL、数据写入／迁移、并发、状态机与失败恢复等行为变化应补足有价值的回归；简单映射或局部判断不自动另起一组测试。需要验证 `packages/db` 的 SQL 行为时，用 `@weq/testkit` 的 `createSqliteStub()` 对明文 SQLite 夹具跑真实 src 代码路径。

纯 UI 布局／样式／文案、图标和入口增删默认不新增自动化；不为固定措辞、类名、DOM 形状或源码片段写锁定测试。不强制每个修复先红后绿，不为缺少测试专门新建夹具、浏览器脚本或测试框架。只能靠真机真 QQ 验证的路径，如实说明实际验证范围。

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

文档站用 VitePress，**内容目录就是 `docs/` 本身**（配置在 `docs/.vitepress/`）。
`docs/` 是 `weq-devs/WeqDocs` 的 **submodule** —— 文档内容在那边提交，主仓只记一个指针。

文档站是独立 workspace，使用 `docs/pnpm-workspace.yaml` 与自己的锁文件，不参与主仓依赖安装。
根目录先运行 `pnpm docs:install`，再用 `pnpm docs:dev` 本地预览（http://localhost:5174）、
`pnpm docs:check` 检查或 `pnpm docs:build` 构建；也可进入 `docs/` 执行对应命令。
clone 主仓时要带 `--recurse-submodules`，否则 `docs/` 是空的。

改完文档记得**两边都提交**：先 `cd docs && git commit && git push`，再回主仓提交指针。
`.github/workflows/docs.yml` 会校验指针指向的提交确实已推送。

### 放哪个目录

| 目录 | 放什么 | 进站点 |
| --- | --- | --- |
| `docs/guide/` | 用户向的用法 / 功能说明 | ✅ |
| `docs/develop/` | 开发向的**常青**内容：协议、架构、踩坑记录 | ✅ |
| `docs/database/` | 表结构与字段 | ✅ |
| `docs/develop/principles/` | 解密、密钥派生等原理 | ✅ |
| `docs/notes/` | 过程记录：阶段计划、验收回执、TODO 清单 | ❌ |

**判断标准**：半年后有人改这块代码，读它有用吗？有用 → `develop/`，只记录「当时做到哪一步」→ `notes/`。
`notes/` 里写什么都不会被检查覆盖，也不会出现在站点和搜索里，**不要把 TODO 倒进 `develop/`**。

### 写文档时的硬约束

- 跨目录引用 `docs/` 之外的文件（源码、`CONTRIBUTING.md`、`CHANGELOG.md`）一律写 **GitHub 绝对 URL**
  （`https://github.com/weq-devs/WeQ/blob/dev/<path>`）。写相对路径会让 VitePress 把它当站内路由解析并构建失败。
- 提示块用 VitePress 语法：`::: tip` / `::: info` / `::: warning` / `::: danger`，不要用 `> [!tip]`。
- 代码块外不要出现裸尖括号占位符（`<字段名>`、`<uin>`）。VitePress 把 md 编译成 Vue SFC，会被当标签解析 ——
  写成 `` `<字段名>` `` 或全角 `〔字段名〕`。
- 新增进站页面要**同时加进 `docs/.vitepress/nav.mts` 的侧栏**，否则它是孤儿页面。
- `docs/notes/README.md` 里写了隔离区的完整约定。

### 检查

- `pnpm docs:check`：调用文档仓的 `check-docs.mjs` 检查链接完整性，`build` 前自动跑。
- 文字修改只核改动内容、新增链接和命令；新增站点页面／导航或修改 Markdown 扩展、主题和构建配置时，再按需运行 `pnpm docs:check`／`pnpm docs:build`。不为一处文案默认构建整站。
- 改了对外行为 / 配置项 / 接口，顺手把对应文档一起改，别留旧描述。

## 9. 红线

- 不提交 `.env`、密钥、Cookie、抓包里的真实 uin / 好友数据；隐私数据要么脱敏要么不入库。
- 不碰 `main` 分支和 `CHANGELOG.md` 的已发布章节；不对共享分支 force push。
- 不做与任务无关的大范围重排 / 重命名 / 全仓格式化，别「顺手」改别人的代码。
- 需要产品决策的事（做不做某功能、UI 怎么摆）先问，别替用户拍板。
- 全新功能按 [CONTRIBUTING.md](./CONTRIBUTING.md) 先开 Issue 对齐方向再写代码。

## 10. 收工前自检

- [ ] 落点正确（提 PR 走特性分支、直接 push 落 `dev`），改动聚焦单一主题
- [ ] 已按实际风险完成最小充分验证；没有因检查清单而补跑无关或重复项目
- [ ] 新功能 / bug 修复已写进 `CHANGELOG.md` 的 `## Unreleased - 进行中`（没有这一节就先补上）
- [ ] 如有新增自动化，保护的是长期行为且不重复现有覆盖，没碰真 QQ 数据／网络
- [ ] 如需 UI 自验，只检查受影响的代表状态，不默认展开主题／尺寸／背景矩阵
- [ ] 相关类型、常量、文档同步更新
- [ ] 提交信息符合 Conventional Commits
