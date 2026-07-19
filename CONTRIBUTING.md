# 贡献指南

感谢你愿意为 WeQ 做出贡献！为了让协作更顺畅、减少来回返工，请在提交 PR 前完整阅读本文档。

---

## 目录

- [开发环境](#开发环境)
- [提交前检查（必须）](#提交前检查必须)
- [分支规范](#分支规范)
- [Commit 规范](#commit-规范)
- [提交 Pull Request](#提交-pull-request)
- [提交 Issue](#提交-issue)

---

## 开发环境

- **Node.js** ≥ 22
- **包管理器**：[pnpm](https://pnpm.io/)（本仓库锁定 `pnpm@10.33.2`，请勿使用 npm / yarn，以免破坏 `pnpm-lock.yaml`）

```bash
pnpm i        # 安装依赖
pnpm dev      # 启动桌面端开发
```

更多背景见[项目架构](./docs/develop/architecture.md)与[原理文档](./docs/principles/index.md)。

---

## 提交前检查（必须）

提交 PR 前，请在本地依次跑通以下命令，确保没有引入回归：

```bash
pnpm typecheck    # 类型检查(CI 强制，不通过会被拦截)
pnpm lint         # Biome 代码规范检查
pnpm format:check # Biome 格式检查
```

- **`pnpm typecheck` 是 CI 的强制门槛**：CI 会在 PR 上运行 `pnpm -r typecheck`，不通过的 PR 无法合并。请务必本地先跑通。
- **`pnpm lint` / `pnpm format`**：本仓库使用 [Biome](https://biomejs.dev/) 统一 lint 与格式。Biome 是**中途引入**的，存量告警仍在逐步清理中，因此 lint 目前**不是 CI 硬门槛**；但请**不要在你改动的代码里引入新的告警**。
  - 一键修复可自动处理的问题：`pnpm lint:fix`
  - 一键格式化：`pnpm format`
- 请**只格式化你改动的代码**，不要在功能 PR 里顺手格式化整个文件/整个仓库，以免 diff 淹没真正的改动、增加 review 负担。

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
2. 本地跑通[提交前检查](#提交前检查必须)。
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
