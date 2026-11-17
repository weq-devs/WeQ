import { createElement } from 'react';
import { SiQzone } from './reactIcons';
import type { FeatureIconProps } from './featureIcons.shared';

export function QzoneIcon(props: FeatureIconProps) {
  // 品牌标识是填充轮廓，不能让线稿入口传入的描边堵住内部留白。
  return createElement(SiQzone, { ...props, stroke: 'none', strokeWidth: 0, focusable: false });
}
export type { FeatureIcon } from './featureIcons.shared';
