/** 用所属文档的时间轴对齐当前一轮；晚挂载、换图或恢复动态效果都沿用同一相位。 */
export function synchronizeLoadingAnimationPhase(reel: HTMLElement): void {
  const now = reel.ownerDocument.timeline?.currentTime;
  if (typeof now !== 'number') return;
  for (const animation of reel.getAnimations?.({ subtree: true }) ?? []) {
    const duration = animation.effect?.getTiming().duration;
    if (typeof duration !== 'number' || duration <= 0 || !Number.isFinite(duration)) continue;
    animation.startTime = Math.floor(now / duration) * duration;
  }
}
