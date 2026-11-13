# 贡献指南

感谢你愿意为 WeQ 做出贡献！为了让协作更顺畅、减少来回返工，请在提交 PR 前完整阅读本文档。

---

## 目录

- [开发环境](#开发环境)
- [提交前检查](#提交前检查)
- [分支规范](#分支规范)
- [Commit 规范](#commit-规范)
- [提交 Pull Request](#提交-pull-request)
- [提交 Issue](#提交-issue)

---

## 开发环境

- **Node.js** ≥ 22.12.0
- **包管理器**：[pnpm](https://pnpm.io/)（本仓库锁定 `pnpm@12.8.1`，请勿使用 npm / yarn，以免破坏 `pnpm-lock.yaml`）
- **Go**：用于首次或源码更新时构建远程网络辅助程序，版本要求见 `tools/remote-network/go.mod`。本地 native 源码模式另外需要其平台对应的 Rust/Cargo 和系统编译工具链。

```bash
pnpm dev           # 自动补依赖、准备 native 与构建，然后启动桌面开发
pnpm dev --prepare-only # 只准备开发环境，不启动应用
```

更多背景见[开发者入口](./docs/develop/index.md)与[原理文档](./docs/principles/index.md)。
默认使用锚定的发布版 native；参与 native 开发时在不入库的 `weq.dev.local.json` 中选择 `local` 并设置源码目录。配置、缓存、镜像与失败处理见[一行命令开发启动](./docs/develop/dev-startup.md)。

---

## 提交前检查

日常改动先运行与修改直接相关的检查，并在 PR 中说明验证范围与结果；不要求每次提交或
push 前运行全量本地 CI。只改文档时核对命令、链接与源码行为；修改纯逻辑或修复 bug 时
补充针对性回归测试。最终以 CI 全量门禁为准。

发版前、大改动或需要全量复核时，可运行：

```bash
pnpm ci:local   # 一键跑 CI 的 lint / format / typecheck / test 门禁
```

`pnpm ci:local` 把 `.github/workflows/ci.yml` 的门禁在本地按同样顺序复刻一遍，
不 fail-fast —— 那一步红了也继续跑完，最后给一张汇总表。常用参数：

- `pnpm ci:local --fix` —— 先 `pnpm format` + `pnpm lint:fix` 刷平，再跑门禁。
  改完代码懒得管格式时用这个，省得再来一轮。
- `pnpm ci:local --full` —— 额外跑 web 打包冒烟（≈ CI 的 `build-web` job）。
- `pnpm ci:local --fail-fast` / `--list` —— 失败即停 / 只打印将跑的步骤。

独立 daemon 已移除；默认发布版 native 模式不需要 Rust 工具链，只有本地 native 源码编译需要。

需要单独跑某一步时，等价命令是：

```bash
pnpm lint         # Biome 代码规范检查
pnpm format:check # Biome 格式检查
pnpm typecheck    # 类型检查（CI 强制，不通过会被拦截）
pnpm test         # 有界并发的全量单测（含 @weq/web），汇总所有失败
pnpm test:fail-fast # 本地全量范围，首个失败后尽早停止
pnpm test:changed # 日常只跑改动相关的 Vitest 测试；Web 仍跑完整服务端断言
pnpm check        # Biome 的 lint + format 汇总检查
pnpm --filter @weq/web build

```

Actions 将 desktop / service 全量测试分片并行，其余包及 Web 服务端断言独立运行，
由 `test` 汇总全部结果。类型检查分为桌面主进程、桌面渲染、Web 服务端和基础包四组，
缓存增量编译信息但每次仍执行检查，由 `typecheck` 汇总结果。
分片复现、成本报告和缓存说明见[测试约定](./docs/develop/testing.md#ci-分片)。

> 桌面端打包（`electron-vite build` + `electron-builder`）不在 PR 门禁里，
> 由 release 流水线兜底。改动打包链路时本地用
> `pnpm --filter @weq/desktop build:unpack` 单独验一遍即可。

---

## 分支规范

- **所有 PR 必须以 `dev` 分支为基础分支（base branch）提交，这是硬性要求。**
  - `main` 为发布分支，只接受来自 `dev` 的合并，**不接受**直接对 `main` 的 PR。
  - 请从最新的 `dev` 拉出你的功能分支，完成后向 `dev` 发起 PR。
- **分支命名**：采用 `类型/简短描述` 的形式，类型与 commit 一致，描述用小写短横线连接。例如：

  ```
  feat/linux-adaptation
  fix/anti-recall-graytip
  refactor/test-config-cleanup
  docs/contributing
  ```

开始一个新分支的典型流程：

```bash
git checkout dev
git pull
git checkout -b feat/your-feature
```

---

## Commit 规范

本仓库遵循 [Conventional Commits](https://www.conventionalcommits.org/)：

```
<类型>(<可选范围>): <简短描述>
```

- 描述可用中文。
- 常用**类型**：

  | 类型       | 用途                                   |
  | ---------- | -------------------------------------- |
  | `feat`     | 新功能                                 |
  | `fix`      | 修复 bug                               |
  | `refactor` | 重构（不改变外部行为）                 |
  | `docs`     | 文档改动                               |
  | `style`    | 代码风格/格式（不影响逻辑）            |
  | `test`     | 测试相关                               |
  | `chore`    | 构建、CI、依赖等杂项                   |
  | `perf`     | 性能优化                               |

- **范围（scope）** 可选，用于标注改动模块，如 `refactor(types):`、`style(lint):`。
- 示例（取自实际历史）：

  ```
  feat: revoke viewing && export sysFace
  fix: 灰条撤回消息显示 bug
  refactor(types): 消除 4 处 explicit any
  chore: 接入 Biome lint
  docs: 文档中心框架
  ```

---

## 提交 Pull Request

1. **确认基础分支为 `dev`**（见[分支规范](#分支规范)）。
2. 完成相关[提交前检查](#提交前检查)，说明未运行或未通过的项目。
3. **判断你的改动是否属于「全新功能」**：
   - **全新功能必须先提 [Issue](../../issues) 讨论并达成一致，再提交 PR。** 未经 Issue 讨论直接提交的新功能 PR 会被关闭（close）。
   - 这样做是为了在你投入大量精力前对齐方向，避免功能与项目规划冲突而白费工作。
   - Bug 修复、文档完善、小改进可直接提 PR，无需先开 Issue（但在描述里说明背景会更好）。
4. PR 描述里请说明：**改了什么、为什么改**；若关联 Issue，请注明 `close #<编号>`。
5. 保持 PR 聚焦单一主题，不要在一个 PR 里混入多个不相关的改动。

---

## 提交 Issue

- 代码问题、bug、功能建议优先在 [Issue](../../issues) 提出。
- 提 bug 时请尽量提供：复现步骤、期望行为、实际行为、系统/QQ 版本等信息。
- 提新功能建议时请说明使用场景，方便讨论是否纳入。

---

再次感谢你的贡献！🎉
