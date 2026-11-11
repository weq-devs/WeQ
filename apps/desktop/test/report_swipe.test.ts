import { afterEach, expect, it } from 'vitest';
import {
  reportSwipeDirection,
  reportCanTurn,
  reportGestureTarget,
} from '../src/renderer/src/lib/reportSwipe';

afterEach(() => document.body.replaceChildren());

it('上下滑动一次只返回一个方向，短距与横向手势不翻页', () => {
  expect(reportSwipeDirection(4, -70)).toBe(1);
  expect(reportSwipeDirection(4, 70)).toBe(-1);
  expect(reportSwipeDirection(4, 25)).toBe(0);
  expect(reportSwipeDirection(90, 60)).toBe(0);
});

it('当前页可继续滚动时不翻页，边缘才允许下一次手势', () => {
  const host = document.createElement('div');
  const page = document.createElement('div');
  page.style.overflowY = 'auto';
  host.append(page);
  document.body.append(host);
  Object.defineProperties(page, { scrollHeight: { value: 1000 }, clientHeight: { value: 400 } });
  page.scrollTop = 100;
  expect(reportCanTurn(page, host, 1)).toBe(false);
  expect(reportCanTurn(page, host, -1)).toBe(false);
  page.scrollTop = 600;
  expect(reportCanTurn(page, host, 1)).toBe(true);
  expect(reportCanTurn(page, host, -1)).toBe(false);
  page.scrollTop = 0;
  expect(reportCanTurn(page, host, -1)).toBe(true);
});

it('嵌套滚动容器、图表与交互控件不被舞台手势接管', () => {
  const host = document.createElement('div');
  host.innerHTML = '<button>分享</button><a href="#">链接</a><canvas></canvas><p>正文</p>';
  expect(reportGestureTarget(host.querySelector('button'))).toBe(false);
  expect(reportGestureTarget(host.querySelector('a'))).toBe(false);
  expect(reportGestureTarget(host.querySelector('canvas'))).toBe(false);
  expect(reportGestureTarget(host.querySelector('p'))).toBe(true);
});
