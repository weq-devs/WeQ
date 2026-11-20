# WeQ 开发约定

本文件提供仓库导航和常用约定。公开协作见[贡献指南](./CONTRIBUTING.md)，开发专题按[开发者入口](./docs/develop/index.md)查阅。

## 从哪里改

| 路径 | 职责 |
| --- | --- |
| `apps/desktop` | Electron 主进程、预加载和共用业务界面 |
| `apps/web` | 浏览器版 WeQ，复用桌面业务界面与后端 |
| `packages/*` | 数据库、编解码、服务、机器人、原生绑定和测试工具 |
| `vendor/weqbot` | WeqBot 子模块及 `@weqbot/protocol` 的唯一实现 |
| `native` | nt_helper 产物的固定版本清单 |
| `docs` | WeqDocs 子模块和 VitePress 文档站 |

- 使用 [`package.json`](./package.json) 指定的 Node 和 pnpm 版本。`pnpm dev` 准备依赖、native 和必要构建，来源配置见[开发启动](./docs/develop/dev-startup.md)。
- 先搜现有实现。共用能力优先复用 `packages/service`、`packages/db` 和 `packages/codec` 的接口、类型和工具。协议改动在 WeqBot 实施，再更新子模块指针。
- QQ 能力优先复用 [nt_helper 接口](./docs/develop/nt-helper-interface.md)。表结构查[数据库文档](./docs/database/index.md)，加解密查[原理文档](./docs/develop/principles/index.md)。
- 跨包重构、新增依赖或协议改动先明确影响范围。新增依赖用 `pnpm add` 更新锁文件。产品决策会实质改变结果且当前需求无法判断时，先确认具体选择。

## 分支与提交

- `dev` 是开发基线，`main` 用于发布。公开 PR、特性分支和新功能 Issue 按[贡献指南](./CONTRIBUTING.md#提交-pull-request)办理。
- 提交聚焦当前任务，使用 [Conventional Commits](./CONTRIBUTING.md#commit-规范)。注释和文档沿用仓库中文习惯。
- 新功能、修复和用户可感知的变化写入 `CHANGELOG.md` 的 `Unreleased`。格式与发布整理见[更新日志约定](./CONTRIBUTING.md#更新日志)。
- 凭据、Cookie、真实账号数据、依赖目录、构建产物和 native 二进制留在 Git 之外。测试与文档样本使用脱敏数据。共享分支禁止强制推送。

## 实现与验证

- 用 Biome 检查本次修改的文件，沿用严格 TypeScript。处理实际告警和类型错误，保留现有测试覆盖。
- 按[最小充分验证](./docs/develop/testing.md#日常开发选择最小充分验证)选检查，优先使用相关已有用例与代表状态。单测离线，使用脱敏样本和明文 SQLite 夹具。全量检查与打包命令见[贡献指南](./CONTRIBUTING.md#提交前检查)。
- 桌面及共用界面复用共享组件、语义 token 和有效主题色。按钮层级、危险等级、深色与独立 Web 页的样式约定见[界面实现](./CONTRIBUTING.md#界面实现)。

## 文档

- 对外行为、配置或接口变化时同步相应用户或开发文档。目录、VitePress 写法和验证命令见[文档维护](./CONTRIBUTING.md#文档维护)。
- 修改 `docs/` 正文时，在文档仓提交内容，在主仓提交子模块指针。公开同步要求见[文档维护](./CONTRIBUTING.md#文档维护)。
