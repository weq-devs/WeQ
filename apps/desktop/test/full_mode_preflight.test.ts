import { beforeEach, expect, it, vi } from 'vitest';
import { preflightMediaCompletion } from '../src/renderer/src/views/export/preflight';
const f = vi.hoisted(() => ({ state: vi.fn(), settings: vi.fn(), harvest: vi.fn() }));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    bootstrap: { getFullModeState: { query: f.state }, getSettings: { query: f.settings } },
    account: {
      getGroupAlbumAccessState: { query: async () => ({ qqOnline: true }) },
      refreshRkeys: { mutate: f.harvest },
    },
  },
}));
const dialog = { confirm: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn() };
beforeEach(() => {
  vi.clearAllMocks();
  f.state.mockResolvedValue({ allowed: true });
  f.settings.mockRejectedValue(new Error('不应读取自动偏好判断当前能力'));
  f.harvest.mockResolvedValue(true);
  dialog.confirm.mockResolvedValue(true);
});
it('手动运行态允许时直接采集，不因持久自动偏好关闭而阻止', async () => {
  expect(await preflightMediaCompletion(dialog)).toBe(true);
  expect(f.state).toHaveBeenCalledOnce();
  expect(f.settings).not.toHaveBeenCalled();
  expect(f.harvest).toHaveBeenCalledOnce();
  expect(dialog.confirm).not.toHaveBeenCalled();
});
it.each(['disabled', 'unknown'])('运行态 %s 只允许明确选择本地导出，不偷偷采集', async (kind) => {
  if (kind === 'disabled') f.state.mockResolvedValue({ allowed: false });
  else f.state.mockRejectedValue(new Error('合成读取失败'));
  expect(await preflightMediaCompletion(dialog)).toBe(true);
  expect(dialog.confirm).toHaveBeenCalledOnce();
  expect(f.harvest).not.toHaveBeenCalled();
  dialog.confirm.mockResolvedValueOnce(false);
  expect(await preflightMediaCompletion(dialog)).toBe(false);
});
