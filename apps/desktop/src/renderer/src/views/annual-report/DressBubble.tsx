/**
 * 报告里的一个真气泡 —— 用装扮的九宫格贴图画出来。
 *
 * 与聊天列表那条渲染路径（lib/msgDecorationStyle.ts 的注入式 CSS）刻意分开：那边是
 * 「一个 itemId 一条全局规则、按 data-bubble 选中消息行」，为长列表的复用优化；报告
 * 一页上只有十几个气泡，用内联 style 直接把 border-image 的四个量写上去更简单，也
 * 不会往全局样式表里堆几十条只用一次的规则。
 *
 * 几何与聊天侧同源（都来自 service 的 BubbleSkin.slice / imageSize），只是缩放比例
 * 由调用方给：回忆流里的气泡是「消息」，按 0.34 贴；主体那只是「展品」，要贴到 0.62
 * 才撑得起一整页的视觉重量（见 `scale`）。
 *
 * `skin` 为 null（资源没解析出来）时退回一枚描边方框 —— 位置和尺寸都还在，版式不塌。
 */

import type { CSSProperties, ReactElement, ReactNode } from 'react';
import type { BubbleSkin } from '@weq/service';
import { dressBubbleUrl, dressBubbleFrameUrl } from '../../lib/resourceUrl';

/** 素材是移动端 2x 的；报告里的气泡当展品看，比聊天里的 0.5 再收一档。 */
const SCALE = 0.34;

/** 主体气泡的贴图比例。九宫格是矢量般可拉的，放大只让边框更清楚，不会糊。 */
export const HERO_SCALE = 0.62;

/** 与 lib/dressSkin.ts 的 PAD_RATIO_Y 同源（npTc padding ÷ slice 实测值）。 */
const PAD_RATIO_Y = 0.6;

function px(value: number): string {
  return `${Math.round(value * 100) / 100}px`;
}

/**
 * 一款气泡的 border-image 内联样式。整泡帧动画只取第 1 帧当静态底 —— 报告里同屏
 * 十几个气泡各自播一套 keyframes 太吵，主角气泡的动效交给入场动画去做。
 */
function bubbleStyle(skin: BubbleSkin, scale: number): CSSProperties {
  const { left, top, right, bottom } = skin.slice;
  const wTop = top * scale;
  const wRight = right * scale;
  const wBottom = bottom * scale;
  const wLeft = left * scale;

  const url = skin.animationFrameCount
    ? dressBubbleFrameUrl(skin.itemId, 1)
    : dressBubbleUrl(skin.itemId);

  // 纵向 padding：基础按 0.6 比例，上下切片不对称时用差值补偿（同 lib/dressSkin.ts）。
  const avg = (top + bottom) / 2;
  const topPad = wTop * PAD_RATIO_Y + (avg - top) * scale * 0.5;
  const bottomPad = wBottom * PAD_RATIO_Y + (avg - bottom) * scale * 0.5;

  return {
    color: skin.textColor,
    borderStyle: 'solid',
    borderWidth: 0,
    borderImageSource: `url("${url}")`,
    borderImageSlice: `${top} ${right} ${bottom} ${left} fill`,
    borderImageWidth: `${px(wTop)} ${px(wRight)} ${px(wBottom)} ${px(wLeft)}`,
    borderImageRepeat: 'stretch',
    // 横向内边距必须盖满整条左右切片，文字只能落在中间那 2px 的拉伸区上。
    padding: `${px(topPad)} ${px(Math.max(wLeft, wRight))} ${px(bottomPad)}`,
    minWidth: px((left + right) * scale),
    minHeight: px((top + bottom) * scale),
  };
}

export function DressBubble({
  skin,
  className,
  scale = SCALE,
  style,
  children,
}: {
  skin: BubbleSkin | null;
  className?: string;
  /** 九宫格贴图比例。默认 {@link SCALE}，主体气泡传 {@link HERO_SCALE}。 */
  scale?: number;
  /** 追加样式（字体等）。几何量由本组件计算，会覆盖同名项。 */
  style?: CSSProperties;
  children: ReactNode;
}): ReactElement {
  const cls = `weq-dress-bubble${skin ? '' : ' is-bare'}${className ? ` ${className}` : ''}`;
  return (
    <div className={cls} style={{ ...style, ...(skin ? bubbleStyle(skin, scale) : null) }}>
      {children}
    </div>
  );
}
