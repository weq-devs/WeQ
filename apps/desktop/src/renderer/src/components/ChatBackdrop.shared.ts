/** 滑块只在正在调整时覆盖对应图层的已保存不透明度。 */
export const DRESS_OPACITY_PREVIEW = {
  background: '--weq-preview-background-opacity',
  widget: '--weq-preview-widget-opacity',
} as const;

export type DressOpacityKind = keyof typeof DRESS_OPACITY_PREVIEW;
