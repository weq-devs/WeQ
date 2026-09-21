/**
 * 字体炫彩（`eimg`）的挂载判据 —— 量完气泡尺寸再决定放不放。
 *
 * 光有素材不够：那个动画是「字体出现之初」贴进气泡的一次性光效，画布尺寸是固定的
 * （实测 20405 是 350×{141,82,76,49,109} 五段），所以能不能放、放哪一段，取决于
 * **气泡自己的尺寸**：
 *
 *  - 气泡装得下某段画布 → 放那一段里最小的那个（左上角对齐、原尺寸不缩放不拉伸，
 *    见 lib/dressSkin 的 fontFxRules）；
 *  - 气泡比所有画布都大 → **不放**（放上去会被气泡裁掉一大块，只剩半个特效）。
 *
 * 尺寸必须在浏览器里量，所以这里用 ResizeObserver 盯着行元素：气泡会随文字换行、
 * 字体加载、图片补齐而变尺寸，量一次就定死会漏掉这些变化。观察的是**行**而不是
 * `.message-content` 本身 —— 行节点是 React 稳定持有的那个，内容节点会被
 * 重渲染换掉，而观察行也照样能收到内容变化引起的尺寸变化。
 *
 * 返回值直接就是 `data-fontfx` 的值（`<字体id>-<变体号>`，键里带 id 是为了让同一
 * 元素上「生效字体」与「逐条消息字体」两套规则不互相抢 `@keyframes`）。
 */

import { useEffect, useState, type RefObject } from 'react';
import { pickFontFxFariant, type FontFxSkin } from '../lib/dressSkin';

/** 气泡内容层的选择器（与 lib/dressSkin 的 BUBBLE_CONTENT 一致）。 */
const CONTENT_SELECTOR = '.message-content';

export function useBubbleFontFx<T extends HTMLElement>(
  fx: FontFxSkin | null,
  lineRef: RefObject<T | null>,
): string | undefined {
  const [attr, setAttr] = useState<string | undefined>(undefined);

  useEffect(() => {
    const line = lineRef.current;
    if (!fx || !line) {
      setAttr(undefined);
      return;
    }

    const measure = () => {
      const content = line.querySelector<HTMLElement>(CONTENT_SELECTOR);
      if (!content) {
        setAttr(undefined);
        return;
      }
      const variant = pickFontFxFariant(fx.fx, content.offsetWidth, content.offsetHeight);
      setAttr(variant ? `${fx.itemId}-${variant}` : undefined);
    };

    const observer = new ResizeObserver(measure);
    observer.observe(line);
    measure();

    return () => observer.disconnect();
  }, [fx, lineRef]);

  return attr;
}
