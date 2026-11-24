# 贡献指南

## 目录

- [开发环境](#开发环境)
- [提交前检查](#提交前检查)
- [分支规范](#分支规范)
- [Commit 规范](#commit-规范)
- [更新日志](#更新日志)
- [界面实现](#界面实现)
- [文档维护](#文档维护)
- [提交 Pull Request](#提交-pull-request)
- [提交 Issue](#提交-issue)

## 开发环境

- **Node.js 和 pnpm** 使用 [`package.json`](./package.json) 的 `engines` 与 `packageManager` 声明。依赖和锁文件通过 pnpm 管理。
- **Go**：用于首次或源码更新时构建远程网络辅助程序，版本要求见 `tools/remote-network/go.mod`。本地 native 源码模式另外需要其平台对应的 Rust/Cargo 和系统编译工具链。

```bash
pnpm dev           # 自动补依赖、准备 native 与构建，然后启动桌面开发
pnpm dev --prepare-only # 只准备开发环境，不启动应用
```

更多背景见[开发者入口](./docs/develop/index.md)与[原理文档](./docs/develop/principles/index.md)。
默认使用锚定的发布版 native；参与 native 开发时在不入库的 `weq.dev.local.json` 中选择 `local` 并设置源码目录。配置、缓存、镜像与失败处理见[一行命令开发启动](./docs/develop/dev-startup.md)。

## 提交前检查

日常改动按[最小充分验证](./docs/develop/testing.md#日常开发选择最小充分验证)选择检查，并在 PR 中简述实际验证范围与结果。CI 执行全量门禁。Windows 本地失败时先查清是否为路径、换行、大小写或原生模块差异。

发版前或需要全量复核时运行 `pnpm ci:local`，一次汇总当前工作树的 lint、格式、生成文档、类型和测试结果。开发启动、集成、编排及打包脚本与线上 CI 共用测试入口。线上另有干净检出和跨平台验证。

- `--fix` 先做全仓格式化和自动修复，适用于全量整理。日常只格式化本任务文件。
- `--full` 增加 Web 打包冒烟，`--fail-fast` 首次失败即停，`--list` 只列步骤。

核对待提交和待推送的内容时用对应 Git 基准。推送前先 `git fetch`；`@{upstream}` 是当前分支跟踪的远端分支，例如 `dev` 跟踪 `origin/dev`。

```bash
git diff --cached                       # 待提交内容
git log --oneline '@{upstream}..HEAD'  # 待推送提交
git diff '@{upstream}...HEAD'           # 待推送改动，相对于共同祖先
node scripts/check-docs-submodule.mjs --staged  # 校验暂存的文档指针与配置
node scripts/check-docs-submodule.mjs HEAD      # 校验要推送的提交，可传入具体 SHA
```

`test:changed` 使用当前工作树。即使为 Vitest 传入 `--changed=origin/dev`，也会同时使用暂存和未暂存改动。需要验证具体提交时，以该 SHA 的线上 CI 结果为准。

需要单独跑某一步时，等价命令是：

```bash
pnpm lint         # Biome 代码规范检查
pnpm format:check # Biome 格式检查
pnpm typecheck    # 类型检查
pnpm check        # Biome lint 和格式检查
pnpm --filter @weq/web build
```

[测试约定](./docs/develop/testing.md#单测-test)列出了定向与全量测试命令，并说明分片复现和类型检查。

> 桌面端打包（`electron-vite build` + `electron-builder`）不在 PR 门禁里，
> 由 release 流水线兜底。改动打包链路时本地用
> `pnpm --filter @weq/desktop build:unpack` 单独验一遍即可。

## 分支规范

以下步骤用于准备公开 PR。

- **所有 PR 必须以 `dev` 分支为基础分支（base branch）提交，这是硬性要求。**
  - `main` 为发布分支，只接受来自 `dev` 的合并，**不接受**直接对 `main` 的 PR。
  - 请从最新的 `dev` 拉出你的功能分支，完成后向 `dev` 发起 PR。
- 分支名采用 `类型/简短描述`，类型与 commit 一致，描述用小写短横线连接，如 `feat/linux-adaptation`。

开始一个新分支的典型流程：

```bash
git checkout dev
git pull
git checkout -b feat/your-feature
```

## Commit 规范

本仓库遵循 [Conventional Commits](https://www.conventionalcommits.org/)：

```
<类型>(<可选范围>): <简短描述>
```

常用类型为 `feat`、`fix`、`refactor`、`docs`、`style`、`test`、`chore`、`perf`。范围可选，描述可用中文，如 `fix(chat): 修复撤回提示`。

## 更新日志

[`CHANGELOG.md`](./CHANGELOG.md) 记录正式版本和待发布的 `Unreleased`。正式版发布工作流要求对应版本章节，GitHub Release 将开头的小标题放在下载表上方。QQ 群发版通知和应用内版本公告仅用于正式版，正文沿用章节原顺序。

测试版使用 `vX.Y.Z-beta.N` 这样的标签，GitHub Release 取该标签里的 `Unreleased` 正文，并附自动生成的变更列表。待发布条目继续留在 `Unreleased`，等正式发版时一并整理。

**日常开发**

- 记录新功能、修复和用户能感知的变化，写到顶部的 `## Unreleased - 进行中`。纯内部重构、测试、CI 和文档改动通常不单列；不改已发布章节。
- 参考近期改动量相近的已发布版本，对照代码增删行数、条目数和篇幅，按实际影响精简。不按提交数列清单，也不按代码行数机械凑条数。
- 沿用 `- **主题**：一句话说明变化。`，用简短中文直说用户能看到什么，少写实现细节。参照近期版本，每条一行，去掉 Markdown 标记后约 20 至 25 个字符为宜；不是硬上限，不为凑长度丢掉关键信息。
- 同一功能的开发、优化和相关修补归为一条；能独立感知的功能或修复分开写。不拆成零碎操作，也不把无关变化塞进一条。最重要的变化放第一条，供 WeQ 助手作版本摘要。

**正式发版前**

1. 从上一正式版标签对照到本次候选提交，整理 `Unreleased` 中整个周期的变化。合并同类、拆开混杂条目并按重要性排序，校对事实、格式和每行长度。正文应可直接发布。
2. 将整理后的章节改为 `## <版本号> - <YYYY-MM-DD>`，版本与发布标签一致，日期用北京时间的发布日期。在下方写一个贴合本版主题、延续历史语气的简短 `###` 标题，在上方留出新的 `## Unreleased - 进行中`。
3. 用 `git diff --shortstat <上一正式版标签> <候选提交>` 实算同一范围的新增和删除行数。在条目后空一行，沿用 `**变更规模**：这是一次规模适中的综合性更新。增加了 6,626 行，删除了 18,537 行。` 的格式；按实际规模和更新性质选词，数字用千位分隔。

## 界面实现

- 桌面和共用界面跟随浅深主题、自定义主题色和聊天背景。沿用 [样式入口](./apps/desktop/src/renderer/src/styles/index.css) 的语义 token。高亮、描边、图表与强调色使用 `--weq-accent-effective`，透明色用 `color-mix()` 派生。
- 普通按钮用中性的 `weq-set-btn`，保存、提交、确认或流程的主要下一步加 `weq-set-btn-primary`。一个操作区通常至多一个主按钮。开关和选中状态沿用各自的样式，`weq-set-btn-soft` 是旧中性用法。
- 展开与收起统一使用线形箭头，禁止使用实心三角、三角字符或浏览器默认折叠标记。原生 `details` / `summary` 默认由共用样式绘制箭头，折叠时向右、展开时向下。需要定制位置或布局时，可在 `summary` 下直接放置 Lucide `ChevronRight` / `ChevronDown` 并随状态改变方向。独立页面同样使用线形箭头。
- 全局恢复、永久删除整段历史和清理不可再生媒体等操作用 `data-danger="solid"`。局部恢复、删除单项配置等用 `data-danger="outline"`，只染文字、图标和已有的描边。菜单只染文字和图标。危险与禁用样式沿用控件尺寸、圆角、描边厚度和阴影。危险色独立于主题色，需兼顾悬停和键盘焦点。
- 危险等级由实际操作提供，确认框使用 `danger`，QQ 操作和菜单传递同一等级。文案、提示 `tone`、清空搜索或选择、取消、关闭、返回和普通重试均不触发危险样式。
- 深色差异用 `html[data-theme="dark"]` 覆盖。`dark:` 桥接用于 streamdown。检查硬编码白色遮罩、描边和半透明栏是否适配。聊天浮层与卡片沿用聊天画布的背景处理。
- 功能样式放在 `apps/desktop/src/renderer/src/styles/<功能>.css`，由组件导入。Web 独立页如 `apps/web/src/server/login_page.ts` 用 `prefers-color-scheme` 和页面变量适配浅深色。视觉验证按改动选代表状态，动效变化检查减少动态效果设置。
- 新增会改变布局的交互时，检查内容是否出现、移除、换位或改尺寸，并明确采用共用过渡或保持即时的原因。固定行高列表可显式启用 `WindowedList` 的布局过渡；聊天的实时入场和行内变化由 `ChatTimeline` 处理，先保持阅读位置。首屏、查询换页、虚拟行重新挂载不播入场；减少动态效果时仍保留最终布局和位置补偿。

## 文档维护

文档站正文位于 WeqDocs 子模块。用户手册放 `docs/guide/`，开发专题与原理放 `docs/develop/`，字段与表结构放 `docs/database/`，计算器放 `docs/tools/`。过程记录放在 [`notes`](./docs/notes/README.md)，由子模块保存供追溯。

- 站内文档引用主仓源码、贡献指南或更新日志时，用 GitHub 的 `blob/dev` 绝对链接。跨仓链接在文档仓独立检出时也应能打开。
- 提示块使用 VitePress 的 `::: tip`、`::: info`、`::: warning` 或 `::: danger`。尖括号占位符放在反引号中或改用全角括号。
- 新增进站页时更新 [站点侧栏](./docs/.vitepress/nav.mts)。普通文字改动核对内容和受影响链接。新增进站页、改导航或改构建相关配置时，按改动选用 `pnpm docs:check` 或 `pnpm docs:build`。
- 文档依赖与应用分开管理。安装、预览及构建命令见 [WeqDocs README](./docs/README.md)。发布主仓子模块指针前，先让对应文档提交能从文档远端取得。

## 提交 Pull Request

1. **确认基础分支为 `dev`**（见[分支规范](#分支规范)）。
2. 完成相关[提交前检查](#提交前检查)，说明未运行或未通过的项目；有用户可感知的变化时，按[更新日志](#更新日志)补写 `Unreleased`。
3. 公开贡献全新功能时先在 [Issue](https://github.com/weq-devs/WeQ/issues) 中达成一致，再提交 PR。修复、文档和小改进可直接提 PR。
4. PR 描述里请说明：**改了什么、为什么改**；若关联 Issue，请注明 `close #<编号>`。
5. 保持 PR 聚焦单一主题，不要在一个 PR 里混入多个不相关的改动。

## 提交 Issue

- 代码问题、bug、功能建议优先在 [Issue](https://github.com/weq-devs/WeQ/issues) 提出。
- 提 bug 时请尽量提供：复现步骤、期望行为、实际行为、系统/QQ 版本等信息。
- 提新功能建议时请说明使用场景，方便讨论是否纳入。
