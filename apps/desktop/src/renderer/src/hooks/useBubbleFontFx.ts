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
 * 返回 `data-fontfx` 并维护独立的绘制层，不占用气泡背景或气泡动画的伪元素。
 */

import { useEffect, useState, type RefObject } from 'react';
import {
  BUBBLE_CONTENT,
  FONT_FX_LAYER_CLASS,
  pickFontFxFariant,
  type FontFxSkin,
} from '../lib/dressSkin';

export function useBubbleFontFx<T extends HTMLElement>(
  fx: FontFxSkin | null,
  lineRef: RefObject<T | null>,
) {
  const [attr, setAttr] = useState<string>();
  const frames = fx?.fx;
  const fontId = fx?.itemId;
  const version = fx?.deriveVersion;

  useEffect(() => {
    const line = lineRef.current;
    if (!frames || fontId === undefined || version === undefined || !line) {
      setAttr(undefined);
      return;
    }

    let layer: HTMLSpanElement | undefined;
    const measure = () => {
      const content = line.querySelector<HTMLElement>(BUBBLE_CONTENT);
      const variant =
        content && pickFontFxFariant(frames, content.offsetWidth, content.offsetHeight);
      if (!content || !variant) {
        layer?.remove();
        setAttr(undefined);
        return;
      }
      // 正文是 React 自己维护的节点，装饰空层不加入它的 React 子树。
      if (!layer) {
        layer = document.createElement('span');
        layer.className = FONT_FX_LAYER_CLASS;
        layer.style.position = 'absolute';
        layer.setAttribute('aria-hidden', 'true');
      }
      if (layer.parentElement !== content) content.append(layer);
      setAttr(`${fontId}-${variant}`);
    };

    const observer = new ResizeObserver(measure);
    observer.observe(line);
    // 正文可能原尺寸原位替换（如 Markdown 显示切换），只靠 ResizeObserver 不会重定向绘制层。
    const mutations = new MutationObserver(measure);
    mutations.observe(line, { childList: true, subtree: true });
    measure();

    return () => {
      observer.disconnect();
      mutations.disconnect();
      layer?.remove();
    };
  }, [frames, fontId, version, lineRef]);

  return frames ? attr : undefined;
}
