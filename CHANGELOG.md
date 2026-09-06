# Changelog

本文件是 WeQ 版本更新的**唯一内容源**（约定）：

- **推文（WeQ 助手「版本发布」）**：新 release 发布时，推文的正文取这里对应版本的章节；
- **Release action**（`.github/workflows/release.yml`）：QQ 群通知与 Release 说明同样从这里取内容 —— 改这里一处，三端（推文 / QQ 通知 / Release 页）一致；
- **系统通知**：GitHub Release 监控弹出的系统提示用每章第一条 bullet 作为摘要。

## 格式约定

```markdown
## <版本号> - <YYYY-MM-DD>
- 第一条 bullet 会作为通知 / 卡片的摘要（一句话，别太长）
- 其余 bullet 按需展开
```

版本号与 git tag（`v<版本号>`）严格一致；最新章节放最上面。

## 0.4.6 - 2026-09-07

- 守护进程（weq-daemon）原生模块落地：开机自启的回环静态 HTTP 服务器，服务 WeQ 助手推文
- WeQ 助手重构为「发布到 docroot + 守护进程 HTTP」架构，控制走本地管道

## 0.4.5 - 2026-08-26

- MCP 新增工具：好友空间导出等

## 0.4.4 - 2026-08-09

- 年度报告「历史以来」模式
