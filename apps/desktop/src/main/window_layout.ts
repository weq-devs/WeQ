/** 登录采用竖版窗口；主界面仍使用原有聊天尺寸与最小边界。 */
export const WINDOW_LAYOUTS = {
  home: { width: 440, height: 680, minWidth: 360, minHeight: 480 },
  chat: { width: 1180, height: 760, minWidth: 940, minHeight: 520 },
} as const;
export type WindowLayout = keyof typeof WINDOW_LAYOUTS;
type Bounds = { x: number; y: number; width: number; height: number };
type LayoutWindow = {
  isMaximized(): boolean;
  isFullScreen(): boolean;
  getBounds(): Bounds;
  getContentSize(): number[];
  setMinimumSize(width: number, height: number): void;
  setContentSize(width: number, height: number): void;
  setPosition(x: number, y: number): void;
};
const appliedLayouts = new WeakMap<LayoutWindow, WindowLayout>();

export function applyWindowLayout(win: LayoutWindow, layout: WindowLayout, area: Bounds): void {
  // 同一窗口内重载或重复 IPC 不重置用户调整后的几何；真正切换首页/工作区才调整。
  if (appliedLayouts.get(win) === layout) return;
  if (win.isMaximized() || win.isFullScreen()) return;
  const size = WINDOW_LAYOUTS[layout] ?? WINDOW_LAYOUTS.home;
  const before = win.getBounds();
  const [contentWidth = before.width, contentHeight = before.height] = win.getContentSize();
  const frameWidth = Math.max(0, before.width - contentWidth);
  const frameHeight = Math.max(0, before.height - contentHeight);
  // 先解除聊天窗口的最小宽度，否则 Electron 会把竖版尺寸夹回 940px。
  win.setMinimumSize(Math.min(size.minWidth, area.width), Math.min(size.minHeight, area.height));
  win.setContentSize(
    Math.max(1, Math.min(size.width, area.width - frameWidth)),
    Math.max(1, Math.min(size.height, area.height - frameHeight)),
  );
  const after = win.getBounds();
  const x = Math.round(before.x + (before.width - after.width) / 2);
  const y = Math.round(before.y + (before.height - after.height) / 2);
  win.setPosition(
    Math.max(area.x, Math.min(x, area.x + area.width - after.width)),
    Math.max(area.y, Math.min(y, area.y + area.height - after.height)),
  );
  appliedLayouts.set(win, layout);
}
