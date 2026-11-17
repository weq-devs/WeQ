/**
 * 聊天背景层 —— 底图 + 可选的浮屏挂件动画,铺在消息列表后面。
 *
 * ## 为什么挂在 `.chat-pane` 而不是 `.chat-main`
 *
 * `.chat-main` 是聊天 / 联系人 / 导出三个视图共用的容器(见 styles/index.css 里
 * `--weq-chat-bg` 的说明),把背景贴在它上面会漏到另外两个页面去。`.chat-pane` 只有
 * 会话视图用,而且本来就是 `position: relative`,正好当定位上下文。
 *
 * ## 尺寸
 *
 * 底图素材是手机端的 720×1280(9:16),桌面窗口通常更宽,所以用 `cover` + 居中:永远填满,
 * 只切掉溢出的那一维。不用 `100% auto`(宽对齐) —— 宽窗口下那样会把中间一条横向拉满、
 * 上下切掉极多。
 *
 * 动态背景(本地 mp4/webm/mov)走同一条裁切:视频元素 `object-fit: cover` + `center`,
 * 与背景图的 `background-size/position` 所见一致 —— 用户在装扮页预览里看到的裁切,
 * 就是聊天窗里的裁切。
 *
 * 挂件动画同样是 9:16,但它不能像底图那样裁 —— 裁掉的是动画内容。那边改的是**画布本身**,
 * 见 {@link ScreenWidget} 和 lib/widenLottie。
 *
 * ## 挂件为什么不复用 FaceLottie
 *
 * 表情包那套把 JSON `fetch` 下来当 `animationData` 传进去,而这批浮屏的图片是**外链**
 * (`"u":"images/"`),不给 `assetsPath` 会全部相对页面 origin 解析 → 全 404。
 * 另外只能用 `lottie_light`:CSP 的 `script-src` 不含 `unsafe-eval`,而完整版靠 eval
 * 求表达式(这也是挂件列表排除第 9 款的原因,见 dressup 路由的 EXCLUDED_WIDGETS)。
 */

/** 背景层的 CSS 变量名。装扮页拖滑块时直接改它做实时预览。 */
export const BACKDROP_VEIL_VAR = '--weq-chat-backdrop-veil';

/**
 * 清晰度(0–1)→ 磨砂纱的厚度。
 *
 * 调纱而不是调整层的 `opacity`:后者会把挂件动画一起冲淡,而挂件是前景装饰,
 * 不该跟着底图变淡。纱越厚 = 底图越淡。最清晰时也留 22% —— 全裸的照片会盖过消息。
 */
export function backdropVeil(opacity: number): string {
  return `${Math.round((1 - opacity) * 70 + 22)}%`;
}
