import { expect, it } from 'vitest';
import { advanceTimelinePrewarm } from '../src/renderer/src/lib/timelinePrewarm';

const keys = Array.from({ length: 28 }, (_, index) => String(index));
const index = new Map(keys.map((key, position) => [key, position]));
const geometry = keys.map((_, position) => ({ start: position * 100, end: (position + 1) * 100 }));
const UNIT = 512 * 1024;
const options = {
  keys,
  index,
  geometry,
  bytesAt: () => UNIT,
  visibleStart: 10,
  visibleEnd: 12,
  nearStart: 9,
  nearEnd: 13,
  velocity: 4,
};

it('按视口距离和滚动方向分批准备完整行，近端行留给前台', () => {
  const forward = advanceTimelinePrewarm({ ...options, direction: 1, current: [] })!;
  const backward = advanceTimelinePrewarm({ ...options, direction: -1, current: [] })!;
  expect(forward).toEqual(['14', '15', '16', '8']);
  expect(backward).toEqual(['8', '7', '6', '5']);
});

it('反向时分批淘汰较远行，替换期间遵守内存预算', () => {
  const budget = 3 * UNIT;
  const backward = advanceTimelinePrewarm({ ...options, direction: -1, current: [], budget })!;
  expect(backward).toEqual(['8', '7', '6']);
  const first = advanceTimelinePrewarm({ ...options, direction: 1, current: backward, budget })!;
  expect(first).toEqual(['14']);
  const second = advanceTimelinePrewarm({ ...options, direction: 1, current: first, budget })!;
  expect(second).toEqual(['14', '15', '16']);
  expect(
    advanceTimelinePrewarm({ ...options, direction: 1, current: second, budget }),
  ).toBeUndefined();
});

it('已经来到前台范围的行以及已经移出的键释放预热预算', () => {
  const result = advanceTimelinePrewarm({
    ...options,
    direction: 1,
    current: ['10', '13', 'outdated'],
    budget: UNIT,
  });
  expect(result).toEqual(['14']);
});

it('媒体行按估算开销缩小单批挂载数量', () => {
  expect(
    advanceTimelinePrewarm({ ...options, direction: -1, current: [], bytesAt: () => 2 * UNIT }),
  ).toEqual(['8', '7']);
});

it('滚动时每批最多补两条，只准备正常缓冲前方的近端消息', () => {
  const nearby = { ...options, direction: -1 as const, aheadPixels: 250 };
  const first = advanceTimelinePrewarm({ ...nearby, current: [] })!;
  expect(first).toEqual(['8', '7']);
  const second = advanceTimelinePrewarm({ ...nearby, current: first })!;
  expect(second).toEqual(['8', '7', '6']);
  expect(advanceTimelinePrewarm({ ...nearby, current: second })).toBeUndefined();
});

it('反向时保留仍装得下的旧行，预算满后让位给新方向', () => {
  const nearby = { ...options, direction: 1 as const, aheadPixels: 150, budget: 3 * UNIT };
  const first = advanceTimelinePrewarm({ ...nearby, current: ['8', '7'] })!;
  expect(first).toEqual(['8', '7', '14']);
  const second = advanceTimelinePrewarm({ ...nearby, current: first })!;
  expect(second).toEqual(['8', '14', '15']);
});
