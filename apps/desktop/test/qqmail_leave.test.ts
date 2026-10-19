import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {},
  trpc: { account: ['account'], mail: ['mail'] },
}));
vi.mock('@trpc/react-query', () => ({ getQueryKey: (value: unknown) => value }));
import { purgeAccountQueries } from '../src/renderer/src/lib/leaveAccount';
import { confirmMailAccountLeave, registerMailDraft } from '../src/renderer/src/state/mailDraft';
import { useDialog } from '../src/renderer/src/components/Dialog';

afterEach(() => vi.restoreAllMocks());
describe('邮箱离开账号保护', () => {
  it('账号与邮箱缓存一并清理，保留全局设置缓存', () => {
    const client = new QueryClient();
    client.setQueryData(['account', 'profile'], 'fixture');
    client.setQueryData(['mail', 'status'], 'fixture');
    client.setQueryData(['bootstrap', 'settings'], 'keep');
    purgeAccountQueries(client);
    expect(client.getQueryData(['account', 'profile'])).toBeUndefined();
    expect(client.getQueryData(['mail', 'status'])).toBeUndefined();
    expect(client.getQueryData(['bootstrap', 'settings'])).toBe('keep');
    client.clear();
  });
  it('没有写信时不打扰，未保存或提交期间允许用户取消离开', async () => {
    const confirm = vi.spyOn(useDialog.getState(), 'confirm').mockResolvedValue(false);
    expect(await confirmMailAccountLeave()).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    const release = registerMailDraft(Symbol('fixture'), { dirty: true, busy: false });
    expect(await confirmMailAccountLeave()).toBe(false);
    expect(confirm).toHaveBeenCalledOnce();
    release();
    expect(await confirmMailAccountLeave()).toBe(true);
  });
  it('旧组件清理不能清掉新组件的草稿保护，确认后可继续离开', async () => {
    const oldRelease = registerMailDraft(Symbol('old'), { dirty: true, busy: false });
    const release = registerMailDraft(Symbol('new'), { dirty: false, busy: true });
    oldRelease();
    const confirm = vi.spyOn(useDialog.getState(), 'confirm').mockResolvedValue(true);
    expect(await confirmMailAccountLeave()).toBe(true);
    expect(confirm).toHaveBeenCalledWith(
      '邮件操作尚未结束',
      expect.any(String),
      expect.objectContaining({ okLabel: '离开账号' }),
    );
    release();
  });
});
