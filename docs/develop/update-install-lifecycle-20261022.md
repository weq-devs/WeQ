# 更新安装退出顺序（2026-10-22）

## 断点

主窗口的关闭处理在 `isQuitting` 为假时按用户偏好询问或隐藏到托盘；旧代码只在
`app.before-quit` 中设置该标记。仓库所用 Electron 类型文档明确说明：原生
`autoUpdater.quitAndInstall()` **先关闭全部窗口，后触发普通 before-quit**。
这会让安装过程被原有窗口关闭处理拦住。

本机依赖 `electron-updater/out/MacUpdater.js` 也显示，应用层下载完成后，macOS
仍可能需要异步交给 Squirrel 准备更新，再调用原生 `quitAndInstall`。不能把下载
Promise 已完成当作系统已准备好退出，也不能在用户点击时就提前关闭账号或窗口。

## 修复

- `app_quit_lifecycle.ts` 将原退出准备同时绑定普通 `before-quit` 和原生
  `before-quit-for-update`，一次执行；`index.ts` 复用原保存暂停点、停止诊断和
  清理托盘逻辑，窗口关闭守卫不再拦截已确认安装。
- 主进程只允许已有下载结果的安装，安装在途防重复；保留显式安装、退出不自动安装。
  安装阶段的异步错误送往既有更新事件，失败解除在途，可再次尝试。
- 两处更新入口共用 `useAppUpdate` 的 `installing` 阶段，显示在途按钮；RPC 或事件
  错误后回到已下载阶段。同一错误已通过事件显示时，RPC 拒绝不重复弹框。
- 没有改更新源、签名规则、校验、原生组件有效期或任何安装权限；系统／签名错误
  只报告，不绕过。

## 验证边界

定向测试覆盖更新专用事件先于普通退出、三类关闭偏好、一次清理、未下载拒绝、
安装重复调用与同步／异步失败、设置卡和组件过期弹窗的真实按钮及错误恢复。
使用事件桩和合成更新信息，不下载／执行安装包，不替换已安装应用；不能冒称完成
真实 macOS／Windows／Linux 更新安装或签名验收。

## 后续签名修复

2026-10-25 已确认无证书 macOS 构建还有独立的 ad-hoc cdhash 身份断点，不能靠
本页的退出顺序修复。对应实现与信任边界见 [macOS ad-hoc 更新安装](./macos-adhoc-update-20261025.md)。

## 未保存窗口与退出清理（2026-10-25）

后续调整将 `before-quit` / `before-quit-for-update` 的准备动作限定为窗口放行标记；
诊断、漫游暂停点与托盘释放移至未被取消的 `will-quit`。助手资源的异步停止也在
`will-quit` 等全部窗口同意关闭后进行，原生更新仍直接交接安装器。

合成窗口的 `beforeunload` 会拒绝卸载。未处理 `will-prevent-unload` 时，Electron
会静默取消退出；此时若已销毁托盘与停止服务，就会留下半关闭状态。所有应用窗口
现在共用原生「继续编辑 / 放弃更改」确认，取消时重置窗口放行标记，不提前停止服务。
此事件调用 `preventDefault()` 的含义是**忽略渲染层拦截并继续卸载**，见
[Electron 官方事件说明](https://www.electronjs.org/docs/latest/api/web-contents#event-will-prevent-unload)。

清理结束后使用 `setImmediate` 重走 `app.quit()`。Electron 44.9.0 的本机隔离实测
确认，直接在 `will-quit` 的 Promise 微任务内重入会被忽略，进程继续存活；推迟一轮
后正常触发第二次 `will-quit` 并结束。没有使用 `app.exit()` 绕过更新安装握手。
更新与退出后清除助手忽略已被暂缓的 `will-quit`，保留监听直到可提交的退出请求，
避免清理完成后的再次退出抢在助手确认之前结束进程。

本机用合成 HTML、环回助手资源服务与原生 `terminate:`（Cmd+Q 的应用退出动作）
验证静默拦截反例、取消后服务仍运行、再次放弃更改后端口关闭与进程正常退出。
未打开真实 QQ 数据，也未执行真实更新安装；这不替代完整业务实例的手动验收。
