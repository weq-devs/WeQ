# 模板源码

`src/template` 是可复用的 IM 前端层，包含：

- 聊天外壳、导航栏、侧边栏和布局拖拽
- 会话、联系人、群资料、通知和资料页
- 消息渲染、Markdown、表情、代码块和输入区
- 本地草稿、隐藏消息、偏好设置和布局存储
- demo 数据和轻量扩展注册表

应用层推荐只从公共入口引入：

```ts
import {
  ChatMainContent,
  ChatShell,
  ChatSidebarContent,
  createTemplateDemoData,
  useChatShellController
} from "./template";
```

不要在业务代码里直接引入深层文件，避免把内部实现固定成应用依赖。

## 边界

这些能力建议放在应用层：

- 登录、账号和权限
- 服务端 API 请求
- 文件上传和存储
- 推送通知
- 机器人管理
- 产品名称、Logo 和路由

## 扩展点

模板通过注册表开放 UI 扩展点，默认能力可保留，也可以在前后追加自己的项目能力：

- `composeToolRegistry`
- `composeMessageRenderers`
- `composeComposerActionRegistry`
- `composeProfileActionRegistry`
- `composeConversationDetailActionRegistry`
- `composeSettingsPanelRegistry`
