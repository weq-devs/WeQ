import { expect, it, vi } from 'vitest';
import { synchronizeLoadingAnimationPhase } from '../src/renderer/src/components/intentSense/loadingAnimationPhase';

function fixture(time: number | null, durations: Array<number | 'auto'> = [2400, 2400]) {
  const doc = document.implementation.createHTMLDocument();
  const timeline = { currentTime: time };
  Object.defineProperty(doc, 'timeline', { value: timeline });
  const reel = doc.createElement('span');
  const animations = durations.map((duration) => ({
    startTime: null as number | null,
    effect: { getTiming: () => ({ duration }) },
  }));
  const getAnimations = vi.fn(() => animations);
  Object.defineProperty(reel, 'getAnimations', { value: getAnimations });
  return { reel, animations, timeline, getAnimations };
}

it('同文档内错时挂载的滚动和笔画动画均对齐当前轮次，而非从零起播', () => {
  const f = fixture(5100);
  synchronizeLoadingAnimationPhase(f.reel);
  expect(f.animations.map((animation) => animation.startTime)).toEqual([4800, 4800]);
  f.timeline.currentTime = 5900;
  synchronizeLoadingAnimationPhase(f.reel);
  expect(f.animations.map((animation) => animation.startTime)).toEqual([4800, 4800]);
  f.timeline.currentTime = 7200;
  synchronizeLoadingAnimationPhase(f.reel);
  expect(f.animations.map((animation) => animation.startTime)).toEqual([7200, 7200]);
  expect(f.getAnimations).toHaveBeenCalledWith({ subtree: true });
});

it('子窗使用自己的文档时间轴，不依赖主窗时钟', () => {
  const main = fixture(5100);
  const child = fixture(900);
  synchronizeLoadingAnimationPhase(main.reel);
  synchronizeLoadingAnimationPhase(child.reel);
  expect(main.animations[0]!.startTime).toBe(4800);
  expect(child.animations[0]!.startTime).toBe(0);
});

it('非活动文档不安排动画，减少动态效果时没有动画也可正常处理', () => {
  const inactive = fixture(null);
  synchronizeLoadingAnimationPhase(inactive.reel);
  expect(inactive.getAnimations).not.toHaveBeenCalled();
  const reduced = fixture(5100, []);
  expect(() => synchronizeLoadingAnimationPhase(reduced.reel)).not.toThrow();
});

it('忽略无有效轮长的动画', () => {
  const f = fixture(5100, ['auto', 0, -1, Infinity, NaN]);
  synchronizeLoadingAnimationPhase(f.reel);
  expect(f.animations.every((animation) => animation.startTime === null)).toBe(true);
});
