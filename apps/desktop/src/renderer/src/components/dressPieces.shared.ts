/**
 * 个性装扮的可复用渲染部件 —— 首页（{@link ../views/ChatHome}）与他人的个性主页
 * （{@link ./PersonalityHomeDialog}）共用同一套视觉。
 *
 * 四层自下而上：名片背景 → 浮屏雨 → 头像+挂件 → 个性标签环。尺寸全部由宿主容器上的
 * `--weq-orb-size` 驱动，所以同一组件既能铺满首页、也能缩进一张竖屏卡片。
 */

/** 首页限制视觉边界，避免力导入场或窗口缩小时的过冲遮挡正文。 */
export function boundTagPosition(x: number, y: number, radius?: number) {
  const distance = Math.hypot(x, y);
  const scale = radius !== undefined && distance > radius ? radius / distance : 1;
  return { x: x * scale, y: y * scale };
}
