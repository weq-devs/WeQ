# Web 竖屏布局（2026-10-22）

## 范围与入口

Web 仍通过 `apps/web/vite.config.ts` 复用桌面 React renderer。`ChatShell` 只在
`IS_WEB` 时增加 `weq-web-shell` 和 `MobileWebNavigation`；新样式位于
`styles/mobile-web.css`，断点为 760px。Electron 和 Web 宽屏保留原有外壳。

手机初始进入消息列表，底栏固定为消息、联系人、空间、更多。其余原有功能通过
更多列表调用原有 handler，不新建一套业务路由。聊天、联系人详情和 WorkspacePage
占满屏幕并收起主导航；普通整页工作区放在顶部栏与底栏之间。

主导航顶栏统一显示头像、昵称与 QQ 在线状态，不再显示当前页面标题及右侧加号。
在线状态复用 `OnlineStatus` 的账号查询与刷新，自定义状态保留基础状态、表情和文案；
状态缺失或未知时不显示在线标记。原加号菜单中的 QQ 号搜索、群号搜索、好友通知与
群通知保留在「更多」中。展开全局搜索时暂时隐藏昵称和状态，为搜索输入留出空间。

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

`Modal` 的 Web 遮罩也独立观察可视视口：弹窗通过 portal 挂在 `body`，不能依赖
`ChatShell` 的局部变量。手机居中弹窗按可视高度、顶部偏移与安全区限制尺寸；
锚定浮层保留原定位。QQ 资料编辑器在 760px 及以下统一采用上方标签、下方控件，
地区选择分两列，按钮与下拉框至少 44px 高。WebKit 下显式使用 `menulist-button`
外观与高度，避免原生下拉框忽略最小高度。写说说弹窗在短可视区域内可滚动至底部操作。
QQ 号搜索等目录编辑弹窗限制最大高度并允许纵向滚动，长结果不会被裁切。

现有 `index.css`、`page-chrome.css` 中的桌面规则可能晚于模板样式加载。
手机修正通过 Web 外壳限定并提高必要的选择器优先级，尤其是根高度、会话行高、
未读角标、设置分类布局；不修改全局桌面规则，不用 `dark:`。

会话虚拟列表通过已有 ResizeObserver 读取 `--weq-conversation-row-height`，
手机 CSS 行高与虚拟列表步长共用该值，宽屏回退原有 62px。不能只增大按钮高度，
否则绝对定位的下一行仍会按旧步长排列，覆盖前一行的点击区域。

手机 Web / Remote 输入区常驻且不可隐藏，忽略桌面端的收纳偏好，不提供收起入口。
初次进入、切换或重新激活会话时不自动聚焦，不主动弹出键盘；草稿继续保留。
会话内工具栏两端对齐，按钮之间等间距分布。

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

## 聊天布局回归

`scripts/mobile-chat-layout.test.mjs` 使用真实样式与合成 DOM，在 WebKit 中检查
320/402/430/760px、浅深色、默认/QQNT 外观、有无顶部安全区、单/双行顶栏、
回复建议与引用输入状态，以及短屏下的输入区可见性、标题可见性、工具栏点击命中、等间距分布和长消息限宽；
另检查 1180px 桌面长引用限宽与顶栏高度。
桌面 WebKit 不会生成 iPhone 刘海，测试显式替换安全区值；短屏只验证缩小后的布局，
不替代真机键盘事件验证。

使用本机已有 Playwright 及其匹配的 WebKit，不增加产品依赖：

```sh
WEQ_PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.js \
  node --test scripts/mobile-chat-layout.test.mjs
```

需要显式选择浏览器运行时，可追加 `WEQ_WEBKIT_EXECUTABLE=/absolute/path/to/pw_run.sh`。
测试结束自动关闭本轮浏览器；只用合成消息，不连接业务服务或 QQ。

## 页面与弹窗回归

`apps/desktop/test/browser/run-mobile-surfaces.mjs` 使用 Vite 的真实 CSS 构建和实际组件，
通过合成 API 数据检查资料编辑、状态表情选择、QQ 号搜索及长结果、文本收藏、邮箱列表与写信、
频道入口与私聊列表、空间入口与写说说，以及设置分类、外观、账号与消息显示子页。
检查 320/390/430/760px 和 1180px 桌面、长短屏、浅深色、控件限宽、资料字段对齐与尺寸；
另注入仅改变 visual viewport 的键盘场景，检查资料弹窗及写说说底部操作。

```sh
cd apps/desktop
WEQ_PLAYWRIGHT_IMPORT=/absolute/path/to/playwright/index.mjs \
WEQ_BROWSER_EXECUTABLE=/absolute/path/to/pw_run.sh \
  node test/browser/run-mobile-surfaces.mjs
```

可用 `WEQ_MOBILE_ARTIFACTS` 指定截图目录，`WEQ_MOBILE_SURFACES=profile,lookup` 缩小检查范围。
测试自动关闭服务和浏览器，不连接真实 QQ；空间、邮箱、频道的业务内容与真机键盘仍需实机验证。
