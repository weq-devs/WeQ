# 动态装扮频闪回归（2026-10-24）

## 现象

动态头像挂件 / 动态气泡**首次出现时频闪**（每圈动画逐帧闪一下），稳定后逐渐正常。
这类问题修过一次（`65cb537e`），现在回归了。

## 两次修复的对撞

| 提交 | 日期 | 做了什么 |
| --- | --- | --- |
| `65cb537e` | 2026-08-11 | `img.onload` → `img.decode()`；新增全局 `liveImages` **永久强引用**，注释写明「必须有人持有，否则解码缓存被丢弃 → `@keyframes` 第一圈各帧重新解码 → 高频闪烁」；预热后等两个 rAF 再开播 |
| `38686072` | 2026-10-20 | 为修「浏览装扮列表后解码缓存持续累积」（Blink OOM 排查的一部分），把 `liveImages` 换成有界 LRU `decodedImageCache`（64 MiB / 256 张 / 并发 4 / 队列 512 / 15s），**淘汰时 `removeAttribute('src')`** |

`38686072` 的目标（有界）和 `65cb537e` 的目标（在播帧不能被丢）本身冲突，但它只实现了
前者：LRU 淘汰不分「在播」与「只是顺手预热」，而已注入的 `@keyframes` 一直有效。

## 根因（两条，都在首屏资源量大时暴露）

按本机 `~/.config/weq/cache/dress_shared` 实测：挂件单帧 250×295×4 ≈ **0.28 MiB**、平均
**21.2 帧/款** ≈ **6 MiB/款**。

1. **64 MiB 预算只够约 11 款挂件。** 首屏几十条消息各带自己的 40801 装扮时，预解码总量
   迅速超标，LRU 开始淘汰；被淘汰的款动画早就开播了，于是每圈逐帧重解码。
2. **队列满时「假成功」。** 原 `preload` 在 `queue.length >= maxPending` 时直接
   `Promise.resolve()`。512 帧 ≈ 24 款挂件，超出的那批让 `preloadImages` 的
   `Promise.all` 立刻完成 → 两个 rAF 后直接 append `animation`，**「等全部帧解码完再
   开播」的门控被静默绕过**，这批款从第一圈就开始闪。

另外：生效装扮走 `syncDressSkin`（`useDressSkin.ts` 首屏同步注入），
`dressSkin.widgetPendantRules` 里 `animation` 直接写在规则里、从不预热 —— 这条路径
一直没有门控，会和上面两条叠加。

## 修复

`decodedImageCache` 增加两个语义：

- **pin（在播帧）**：`pin(urls)` 返回带引用计数的凭据，被 pin 的帧不参与淘汰；多个
  调用方（时间线 / 合并转发 / 年度报告）各持一份，全部归还后才回到普通 LRU。淘汰不动
  （剩下的都在播）时**容忍短暂超预算** —— 字节预算约束的是可选预热，不是牺牲观感。
- **required 预热**：`require(url)` 在队列超限时进 `requiredWaiting` 等空位（不假成功、
  也不顶爆队列），解码失败会 reject。`preload` 保持「队列满直接放行」的可选语义。

两处投放：

- `msgDecorationStyle`：开播门控改用 `require`，并在 append `animation` 之前 `pin` 这批
  帧（write-once，不归还；数量随会话里真实出现过的装扮款数增长，不是浏览过的全部）。
- `dressSkin`：`applyDressSkin` 每次重写样式时**先钉新的再放旧的**（同款重注入反过来会
  有掉到 0 pin 的窗口）；`applyDressSkinPreloaded` 在 await 之前就临时持有，避免这段等待
  期间被别的预热挤出。

可选预热（`preload`）在预算不足且无可淘汰项时**放弃保留**而不是容忍超额 —— 否则每次
「顺手热一下」都能挤进一个不可淘汰的帧，预算就永久失效，等同把无界累积请回来。

两处在写测试时确认下来的细节：

- **`load` 的失败不能提前 `return`。** 函数末尾的 `throw failure` 是唯一出口，提前
  return 会让必达预热的失败变成静默成功（第一版实现就是这么错的，用例抓到了）。
- **在途任务可被升格。** 同一 URL 先 `preload` 排队、后有人 `require` 时，要把那个任务
  改成必达，且 `resolve/reject` 按**落定时刻**的 `required` 决定 —— 只看入队时的值
  会让 `require` await 到「失败也 resolve」的旧 promise。

## 验证

- `apps/desktop/test/decoded_image_cache.test.ts` 新增 5 例：pin 的帧跨多轮预热不被摘
  src、release 后回到 LRU、多份凭据计数、`require` 不假成功、`require` 失败 reject。
- `apps/desktop/test/decoration_animation_pin.test.ts` 走真实 `injectWidgetCss` 入口：
  注入 20 帧挂件后塞 600 个可选预热，断言在播帧一张都未被摘 src。把淘汰逻辑临时改回
  「不认 pin」复跑，20 帧全部被摘 —— 用例确实抓得住这次的回归。
- `pnpm ci:local --no-daemon` 全绿（lint / format / typecheck / 单测）。

## 未验证

真实 QQ 数据下的观感（首屏同时出现多款动态装扮的频闪是否完全消失）需要真机确认；
合成用例只能证明「在播帧不再被淘汰」「门控不再被绕开」这两条机制成立。
