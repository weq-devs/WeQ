// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { dressupRouter } from '../src/main/ipc/routers/dressup';

const state = vi.hoisted(() => ({
  localBubble: vi.fn(),
  resolve: vi.fn(),
}));
vi.mock('../src/main/context/app_context', () => ({
  getAppContext: () => ({
    services: {
      dressInstall: { localBubble: state.localBubble },
      msgDecoration: { resolve: state.resolve },
    },
  }),
}));

it.each([null, { itemId: 21991 }])('本地查询命中或未命中均不调用下载解析：%s', async (bubble) => {
  state.resolve.mockClear();
  state.localBubble.mockReturnValue(bubble);
  const result = await dressupRouter.createCaller({}).resolveMsgDecoration({
    bubbleId: 21991,
    fontId: 31991,
    widgetId: 41991,
    localOnly: true,
  });
  expect(result).toEqual({ bubble, font: null, widget: null });
  expect(state.localBubble).toHaveBeenLastCalledWith(21991);
  expect(state.resolve).not.toHaveBeenCalled();
});

it('未指定本地查询时保留原下载路径', async () => {
  const result = { bubble: null, font: null, widget: null };
  state.resolve.mockResolvedValue(result);
  expect(await dressupRouter.createCaller({}).resolveMsgDecoration({ bubbleId: 21991 })).toBe(
    result,
  );
  expect(state.resolve).toHaveBeenLastCalledWith({ bubbleId: 21991, fontId: 0, widgetId: 0 });
});
