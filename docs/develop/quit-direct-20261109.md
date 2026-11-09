# 退出直通：Dock / Cmd+Q / 托盘退出不再确认（2026-11-09）

## 问题

2026-10-25 起的「退出确认」在 `before-quit` 里拦一次退出，只要六类后台服务（MCP / OneBot /
公众号推送 / Web / Remote / SSE）有任一在跑，就 `preventDefault()` 并让渲染层弹
`QuitConfirmDialog`（最小化到托盘 / 完全退出 / 取消 + 不再询问）。

实际表现出的问题：

1. **明确的退出指令被再次确认。** macOS Dock 图标右键「退出」是两步操作、意图明确；
   `Cmd+Q`、应用菜单「退出 WeQ」、托盘「退出 WeQ」同理。用户已经回答了「要不要退出」，
   同一个问题再问一次只是每秒都在消耗耐心 —— 开着 MCP 的用户每天都要多点一次。
2. **「最小化到托盘」选项与语境矛盾。** 托盘是关窗语境的动作，放进退出框只会让人误点。
3. **会挡住系统动作。** 系统关机/重启/注销同样走 `before-quit`；确认框超时 60s 后按
   `cancel` 处理，等于「明确要退出，60 秒后程序决定不退」。macOS 注销没有可用的
   Electron 事件（`powerMonitor('shutdown')` 只覆盖关机/重启），拦一次就可能让注销卡住。
4. **「不再询问」是假承诺。** 勾上并选「最小化到托盘」后，`onRemember` 只写
   `quitConfirmSuppressed`，下次退出会直接放行 `app.quit()` —— 与「以后直接按本次选择处理」
   相反。全局布尔也表达不了「按上次选择」，要记就该记 choice。

## 决定

**用户说退出就退出。** 退出一律直通，不再有任何 `before-quit` 拦截；
「退出会停止哪些后台服务」的信息放到它真正有意义的位置：

| 触发 | 行为 |
| --- | --- |
| Dock 图标右键「退出」 | 直接退出 |
| `Cmd+Q` / 应用菜单「退出 WeQ」 | 直接退出 |
| 托盘「退出 WeQ」 | 直接退出 |
| 窗口 ✕ 且 `windowCloseBehavior = 'quit'` | 直接退出（用户已经配置过） |
| 窗口 ✕ 且 `windowCloseBehavior = 'tray'` | 最小化到托盘 |
| 窗口 ✕ 且 `windowCloseBehavior = 'ask'` | 弹 `CloseConfirmDialog`；有后台服务时**列出服务名单**，可选托盘 / 退出 / 取消 |
| 系统关机 / 重启 / 注销 | 直接退出（`will-quit` 的异步清理仍会跑完再退） |

`CloseConfirmDialog` 是唯一还会问的地方：点 ✕ 本身并不表达「结束进程」，此处提示代价
才说得通；其余退出路径不经过 `win.on('close')` 的拦截（`isQuitting` 已置位）。

## 代码变更

- 删除 `apps/desktop/src/main/app_quit_confirmation.ts`、`quit_confirm_ipc.ts`。
- 删除 `apps/desktop/src/renderer/src/components/QuitConfirmDialog.tsx` 与
  `styles/quit-confirm.css`。
- `background_services.ts` 只保留 `backgroundServicesRunning()`，删除
  `needsQuitConfirmation()`；模块注释同步说明「退出不再经过确认」。
- `index.ts`：`before-quit` 只剩 `registerAppQuitPreparation`（置 `isQuitting`）与
  `will-quit` 的清理；`win.on('close')` 的 `window:confirm-close` 载荷增加
  `services: string[]`。
- `CloseConfirmDialog.tsx` 展示服务名单，新增 `styles/close-confirm.css`（走 design token）。
- `host.ts`（重启）/ `storage_cleanup.ts`（退出后清除）不再调用
  `skipNextQuitConfirmation()`，直接 `app.quit()`。
- `quitConfirmSuppressed` 字段保留但不再读取，仅用于旧配置兼容（见
  `packages/service/src/bootstrap/user_config.ts` 类型注释）。

`will-quit` 的两轮语义（`registerAppQuitCleanup` 先 `preventDefault` 做异步清理，再
`app.quit()`）保持不变。

## 验证

```sh
cd apps/desktop && ../../node_modules/.bin/vitest run \
  test/background_services.test.ts test/close_confirm_dialog.test.ts \
  test/app_quit_lifecycle.test.ts test/storage_cleanup_quit.test.ts
pnpm typecheck && pnpm lint
```

真机自验（macOS）：

1. 开启 MCP 与 Web 服务，右键 Dock 图标 →「退出」：应立刻退出，无对话框。
2. `Cmd+Q`、托盘「退出 WeQ」同样直接退出。
3. 关闭行为设为「每次询问」后点 ✕：确认框应列出「MCP 服务器 / WeQ Web 服务」，选「完全退出」后直接退出。
4. 开启「有未保存内容」的界面后退出，仍由 `will-prevent-unload` 明确确认，不静默丢改动。

本轮未在真机逐个切换深浅模式/主题色验证关闭确认框的服务清单；UI 只用了既有 token。
