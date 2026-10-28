import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useAnalyticsExport } from '../src/renderer/src/components/useAnalyticsExport';
import type { AnalyticsExportPayload, AnalyticsExportResult } from '../src/shared/analytics_export';
import { useViewState } from '../src/renderer/src/state/view';

const state = vi.hoisted(() => ({
  send: vi.fn(
    async (_payload: AnalyticsExportPayload): Promise<AnalyticsExportResult> => ({
      saved: false,
      taskId: 'image-task',
    }),
  ),
  toast: vi.fn(),
  current: true,
}));
vi.mock('../src/renderer/src/components/analyticsShot', () => ({
  canExportAnalyticsCard: () => true,
  exportAnalyticsCard: state.send,
}));
vi.mock('../src/renderer/src/components/Toast', () => ({
  useToast: { getState: () => ({ push: state.toast }) },
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    account: {
      getAccountConfig: {
        query: async () => ({ configId: state.current ? 'synthetic' : 'changed' }),
      },
    },
  },
}));
const cleanup: Array<() => void> = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  state.current = true;
  useViewState.setState({ openedUin: '10001' });
  state.send.mockResolvedValue({ saved: false, taskId: 'image-task' });
});
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
  vi.unstubAllGlobals();
});
function Fixture() {
  const action = useAnalyticsExport({
    enabled: true,
    build: () => ({
      kind: 'buddy',
      title: '合成好友',
      label: '好友分析',
      expectedAccountUin: '10001',
      expectedAccountConfigId: 'original-source',
      data: { total: 3 },
    }),
  });
  return h('button', { onClick: action.start, disabled: action.exporting }, '保存为图片');
}
async function save() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(h(Fixture)));
  cleanup.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  await act(async () => host.querySelector('button')!.click());
}
it('报告内图片按钮保留原报告身份，位置策略交公共任务处理，排队不冒称已经保存', async () => {
  await save();
  expect(state.send).toHaveBeenCalledWith(
    expect.objectContaining({
      expectedAccountConfigId: 'original-source',
      data: { total: 3 },
    }),
  );
  expect(state.toast).toHaveBeenCalledWith({ tone: 'info', title: '长图导出任务已创建' });
});
it('取消图片保存不弹失败提示', async () => {
  state.send.mockResolvedValueOnce({ saved: false, canceled: true });
  await save();
  expect(state.toast).not.toHaveBeenCalled();
});
it('报告保存等待期间切源，不把旧任务回执显示在新来源', async () => {
  state.send.mockImplementationOnce(async () => {
    state.current = false;
    return { saved: false, taskId: 'image-task' };
  });
  await save();
  expect(state.toast).not.toHaveBeenCalled();
});
