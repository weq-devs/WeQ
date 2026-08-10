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

import { useEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react';
import { screenWidgetAssetsPath, screenWidgetUrl } from '../lib/resourceUrl';
import { widenLottie } from '../lib/widenLottie';

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

export function ChatBackdrop({
  imageUrl,
  widgetId,
  opacity,
}: {
  /** 底图 url。空串 = 不画底图(但挂件仍可单独生效)。 */
  imageUrl: string;
  /** 浮屏挂件目录名。空串 = 不叠。 */
  widgetId: string;
  /** 底图强度(0–1)。1 = 最清晰。 */
  opacity: number;
}): ReactElement | null {
  if (!imageUrl && !widgetId) return null;

  const style: CSSProperties = { [BACKDROP_VEIL_VAR as string]: backdropVeil(opacity) };
  if (imageUrl) style.backgroundImage = `url("${imageUrl}")`;

  return (
    <div className="weq-chat-backdrop" style={style} aria-hidden="true">
      {widgetId ? <ScreenWidget widgetId={widgetId} /> : null}
    </div>
  );
}

/**
 * 一支浮屏挂件的 lottie 播放器。
 *
 * 装扮页的挂件选择格直接复用它 —— 预览必须跟真实聊天背景是**同一套渲染**,
 * 否则「选之前看到的」和「选之后看到的」会不一样(拿包里第一张图当封面时尤其明显:
 * 那往往只是某一帧的一个碎片)。
 *
 * ## 宽高比
 *
 * 素材是 720×1280 的竖屏,而聊天区是横向矩形 —— 直接播的话 `meet` 按高边贴合,动画只占
 * 中间窄窄一条(容器高 700 时才 394px 宽)。所以先量容器比例、把画布加宽到同比例再播,
 * 见 {@link widenLottie}:那是**拉范围不拉比例**,挂件的视觉大小与原来逐像素一致。
 */
export function ScreenWidget({
  widgetId,
  className = 'weq-chat-widget',
}: {
  widgetId: string;
  /** 容器类名。预览格要自己的尺寸/圆角,所以可换。 */
  className?: string;
}): ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [aspect, setAspect] = useState(0);

  // 量容器比例。**量化到 0.1 档 + 50ms debounce** 再进 state:
  // - 量化:窗口拖动时逐像素变化不触发重建。
  // - debounce:初始布局时 ResizeObserver 会快速连发多次(浏览器在稳定前报多个中间尺寸),
  //   不 debounce 的话每次都会销毁再重建动画 → 闪一堆下。
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      const { clientWidth, clientHeight } = el;
      if (!clientWidth || !clientHeight) return;
      const next = Math.round((clientWidth / clientHeight) * 10) / 10;
      clearTimeout(timer);
      timer = setTimeout(() => setAspect(next), 50);
    });
    observer.observe(el);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    // 首帧容器还没量出来,等 ResizeObserver 回填 —— 先按 720×1280 播再重建会闪一下。
    if (!aspect) return;
    let destroyed = false;
    let anim: import('lottie-web').AnimationItem | undefined;

    void (async () => {
      try {
        // `lottie_light` 去掉了表达式求值器(那玩意用 eval,过不了 CSP 的
        // `script-src 'self'`)。上架的这几款都不含表达式,所以没有损失。
        const [{ default: lottie }, data] = await Promise.all([
          import('lottie-web/build/player/lottie_light'),
          fetch(screenWidgetUrl(widgetId, 'fullscreen.json')).then((r) => {
            if (!r.ok) throw new Error(`widget fetch ${r.status}`);
            return r.json() as Promise<unknown>;
          }),
        ]);
        if (destroyed || !containerRef.current) return;

        anim = lottie.loadAnimation({
          container: containerRef.current,
          renderer: 'svg',
          loop: true,
          autoplay: true,
          // 画布加宽到容器比例,粒子横向平铺填满新增的区域。窄容器(装扮页那个 9:16 的
          // 预览格)会原样返回,那里本来就不需要加宽。
          animationData: widenLottie(data, widgetId, aspect),
          // 缺了这个,JSON 里的图片会相对页面 origin 解析而全部 404。
          // 指向 images/ 且带尾斜杠 —— 两个坑都在 screenWidgetAssetsPath 里说明了。
          assetsPath: screenWidgetAssetsPath(widgetId),
          // 画布已经跟容器同比例了,`meet` 于是正好铺满、不裁不留边。仍然按高边定标,
          // 所以挂件的视觉大小与加宽前一致。
          rendererSettings: { preserveAspectRatio: 'xMidYMid meet' },
        });
      } catch {
        // 挂件是纯装饰,拉不到就当没有 —— 背景底图本身不受影响。
      }
    })();

    return () => {
      destroyed = true;
      anim?.destroy();
    };
  }, [widgetId, aspect]);

  return <div className={className} ref={containerRef} />;
}
