# 合成工作区与归档

当前工作窗将可编辑记录统一放在「合成记录」，可复用快照放在「素材库」。用法见[主界面手册](../guide/homepage.md#合成聊天记录)。

## 存储与兼容

- `MergeForwardDraftStore` 管理可编辑工作区；同一记录续编保留 ID，创建副本才生成新 ID。旧草稿、历史快照及本机恢复副本按身份合并，旧 `history` 只作兼容读取来源。
- `MergeForwardArchiveStore` 保存素材及旧历史快照。数据位于应用数据目录 `merge-forward/<configId>/`，不是可清理的预览缓存；工作区记录在 `drafts.json`，归档在 `archive/`。
- 归档媒体先核账号访问权限，再流式复制并按 SHA-256 复用，元数据原子写入。未下载或未授权的媒体明确失败，不把 URL 当永久副本。
- 删除条目不回收可能被其它素材引用的共享媒体；自动媒体回收尚未实现。损坏元数据不冒充空列表。
- 读取会登记归档媒体用于预览；任意文本分段的 `path` 不进入媒体信任名单。

## 编辑与窗口

- 编辑防抖保存，切换与关闭前等待保存；失败保留内容并阻止离开。本机恢复副本按账号及数据源隔离。
- 消息「添加到素材库」只捕获快照，不切换当前合成。素材拖入复制节点和分段，后续源修改不联动。
- 合成记录默认嵌套插入，也可展开插入；`sourceCompositionId` 用于阻止自身及间接循环，嵌套不超过协议的 8 层。
- Portal、Escape 和装扮/商城浮层使用发起处的 `RenderDocumentContext`，不能误挂到主聊天窗口。
- IPC 要求确认时的 uin/configId；异步复制持有捕获的账号服务，不在中途换成全局新账号。

## 源码与回归

- 服务：`packages/service/src/account/merge_forward_drafts.ts`、`merge_forward_archive.ts`。
- 路由：`apps/desktop/src/main/ipc/routers/merge_forward.ts`。
- 窗口与界面：`main/composition_window.ts`、`components/mergeForward/CompositionWorkspace.tsx`、`workspaceModel.ts`、`workspaceRecovery.ts`。
- 测试：`merge_forward_archive.test.ts`、`merge_forward_drafts.test.ts`、`merge_forward_archive_router.test.ts`、`composition_workspace.test.ts`。

发送、转发、复制、导出及拖入仍需按各自实际路径验收；存储测试通过不等于真实 QQ 收端或重启恢复均已验证。
