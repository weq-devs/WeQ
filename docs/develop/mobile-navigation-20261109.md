# 手机网页导航与 Remote 连接菜单

移动网页沿用现有聊天控制器、工作区页面和页面快照，不引入独立路由框架或动画依赖。

## 连接菜单

Remote 注入 `window.weqRemoteShell.openMenu()`；网页按接口能力显示入口，普通浏览器不显示。Android 加载后通过本地 `weq-remote-shell-ready` 事件通知页面，不增加网络预检。

入口位于现有顶栏，聊天页复用「更多会话操作」中的连接菜单项，其他页面栏使用同款省略号。重新加载、断开和取消由原生操作单完成；删除电脑只在原生首页确认后执行。

## 返回与动效

`MobileBackStack` 只记录现有返回操作，不复制消息或持久化新的路由数据。会话进入记录父层选择，工作区页面、设置分类、空间相册和模态层登记各自返回动作；弹层优先，同层按后进入先返回。需要草稿确认的页面保留登记，只有实际关闭才移除，取消确认不会丢失返回入口。

浏览器保留一个返回哨兵，逐次后退消费一个内部导航层，避免主标签切换堆叠浏览历史。主标签替换根状态；界面按钮、浏览器后退、Android 系统返回和网页左缘手势使用相同处理。顶层不自动断开。

左缘 24px 内开始的横向单指拖动用于返回；输入框、横向滚动控件、滑块和弹层不抢手势。位移达到屏宽 30%（上限 120px），或超过 40px 且速度大于 0.5px/ms 时完成，否则恢复原页面。可用 `data-no-swipe-back` 显式排除控件。

公共容器使用 Web Animations API，详情切换约 200ms，根标签约 120ms；减少动态效果时改用短淡入，不重建整个应用或等待网络。已有快照、草稿与滚动恢复继续使用原有实现。

## 针对性验证

```sh
pnpm --filter @weq/desktop exec vitest run test/mobile_back_stack.test.ts test/remote_shell_menus.test.ts
```

`apps/desktop/test/browser/run-remote-navigation.mjs` 使用合成会话与设置页检查真实 WebKit DOM、菜单、多级返回、侧滑完成及取消、草稿保留和响应式布局。通过 `WEQ_PLAYWRIGHT_IMPORT`、`WEQ_BROWSER_EXECUTABLE` 复用已有浏览器依赖，可用 `WEQ_MOBILE_ARTIFACTS` 指定本地截图目录。该检查不代表 iPhone 或 Android 原生操作单、真实网络切换已经验收。
