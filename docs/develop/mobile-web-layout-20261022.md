# Web 竖屏布局（2026-10-22）

## 范围与入口

Web 仍通过 `apps/web/vite.config.ts` 复用桌面 React renderer。`ChatShell` 只在
`IS_WEB` 时增加 `weq-web-shell` 和 `MobileWebNavigation`；新样式位于
`styles/mobile-web.css`，断点为 760px。Electron 和 Web 宽屏保留原有外壳。

手机初始进入消息列表，底栏固定为消息、联系人、空间、更多。其余原有功能通过
更多列表调用原有 handler，不新建一套业务路由。聊天、联系人详情和 WorkspacePage
占满屏幕并收起主导航；普通整页工作区放在顶部栏与底栏之间。

设置复用 `SettingsDialog` 的分类、二级标签和渲染函数，只增加手机分类列表与
返回层级。指定 `initialSection` 时直接进入目标内容，普通设置入口先显示分类。

## 视口与样式约束

`useMobileWebViewport` 观察可视视口 resize/scroll、窗口 resize 和断点变化，
把高度、顶部偏移写到外壳的局部 CSS 变量。视口不可用时回退窗口高度；高度为零
时保留最后有效值；双指缩放时不重新排版。卸载会移除监听和变量。

只使用 `dvh` 无法证明输入区不会被软键盘遮挡。浏览器平台依据：
[Chrome 的视口与软键盘说明](https://developer.chrome.com/blog/viewport-resize-behavior/)、
[VisualViewport 属性与事件](https://developer.mozilla.org/en-US/docs/Web/API/VisualViewport)。
搜索浮层也观察可视视口，限制结果列表高度。

现有 `index.css`、`page-chrome.css` 中的桌面规则可能晚于模板样式加载。
手机修正通过 Web 外壳限定并提高必要的选择器优先级，尤其是根高度、会话行高、
未读角标、设置分类布局；不修改全局桌面规则，不用 `dark:`。

会话虚拟列表通过已有 ResizeObserver 读取 `--weq-conversation-row-height`，
手机 CSS 行高与虚拟列表步长共用该值，宽屏回退原有 62px。不能只增大按钮高度，
否则绝对定位的下一行仍会按旧步长排列，覆盖前一行的点击区域。

## 验证范围

- 离线组件测试：四个主入口、未读封顶、更多原有 handler、搜索与隐藏状态。
- 离线视口测试：键盘只改变 visual viewport、顶部偏移、缩放、零高度、宽屏恢复、
  无 API 回退和卸载清理。
- Playwright 使用真实 ChatShell、ChatPane、会话列表和 SettingsDialog，业务接口
  使用合成数据，不连接真实 QQ。检查 320/390/430/760px、浅深色、绿色与浅黄色主题、
  短屏输入、搜索、返回、工作区、手机设置及 1180px 桌面回归。
- Web 生产构建与 Electron 依赖隔离检查。

浏览器模拟和可视视口事件注入不等于 iPhone/Android 真机键盘验收；真实 QQ 操作、
相机、Tailscale 网络和原生壳安装不属于本次布局测试的通过声明。
