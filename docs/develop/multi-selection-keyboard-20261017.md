# 多选键盘契约

共享实现为 `hooks/useMultiSelection.ts`，使用稳定身份锚点和当前展示顺序，不按行号保存选择。

| 操作 | 行为 |
| --- | --- |
| Ctrl/Command + 点击 | 切换单项，保留其它选择；支持就地多选的列表可由此进入选择 |
| Shift + 点击 | 从锚点选择范围 |
| Ctrl/Command + Shift + 点击 | 追加范围 |
| Ctrl/Command + A / Shift + A | 全选当前候选 / 清空当前组 |
| 方向键、Home、End | 移动焦点；配合 Shift 扩展范围，配合 Ctrl/Command 追加 |
| Space / Ctrl/Command + Space | 切换焦点项，修饰后的 Space 可进入支持的多选列表 |
| Escape | 退出内容多选或清空工具选择；空选择允许外层继续处理 |
| 消息 Ctrl/Command + C / Shift + C | 复制纯文本 / 富文本 |

## 约束

- 命令仅属于当前聚焦/最近交互的组；输入框、编辑区、其它模态层、隐藏页和禁用组不接受外层命令。
- 筛选外已选身份保留；全选不虚构未加载的服务器条目，也不自动请求全库。
- 内容页共用单一选择状态，工具草稿独立。不同筛选层各建组，不能因批量 setState 闭包而丢失更新。
- 目录选择投影为真实文件身份并防重复；在途只读请求不假装撤销，加载中不能提交不完整范围。
- 最少一种格式、最多分享页数、禁用项和发送中约束仍由各业务维护；快捷键不绕过提交、权限或确认。
- 单选、开关、播放/展开及同意勾选不属于多选，不能被“全选”批量切换。

回归入口：`multi_selection_keyboard.test.ts`、`group_file_selection.test.ts`、`fileSelection.ts` 的各消费方。窗口化列表需实际验证 Shift+End 的焦点与滚动，不能只断言 Set 数量。
