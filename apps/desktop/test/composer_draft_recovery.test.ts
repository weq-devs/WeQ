import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Storage } from 'happy-dom';
import { createComposerDraftRecovery } from '../src/renderer/src/lib/composerDraftRecovery';

beforeEach(() => vi.stubGlobal('localStorage', new Storage()));
afterEach(() => vi.unstubAllGlobals());

it('输入时同步保存，重建实例仍可读取；账号与会话隔离，正文 token 原样保留', () => {
  const first = createComposerDraftRecovery(localStorage);
  const body = '尚未发送\n[[chat:elem:fixture]]  ';
  first.write('account-a', 'u_peer', body);
  first.write('account-a', '12345', '群聊草稿');
  first.write('account-b', 'u_peer', '另一个账号');
  const restarted = createComposerDraftRecovery(localStorage);
  expect(restarted.load('account-a')).toEqual({ u_peer: body, '12345': '群聊草稿' });
  expect(restarted.load('account-b')).toEqual({ u_peer: '另一个账号' });
});

it('清空保留空串覆盖旧 QQ 草稿；迟到保存确认不能删除新的草稿', () => {
  const store = createComposerDraftRecovery(localStorage);
  store.write('a', 'peer', '旧正文');
  store.write('a', 'peer', '');
  expect(store.load('a')).toEqual({ peer: '' });
  store.confirm('a', 'peer', '旧正文');
  expect(store.load('a')).toEqual({ peer: '' });
  store.confirm('a', 'peer', '');
  expect(store.load('a')).toEqual({});
});

it('保存失败明确抛错且保留旧快照；损坏原件不被读取路径删除', () => {
  const store = createComposerDraftRecovery(localStorage);
  store.write('a', 'peer', '原稿');
  const set = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
    throw new Error('quota');
  });
  expect(() => store.write('a', 'peer', '新稿')).toThrow();
  set.mockRestore();
  expect(store.load('a')).toEqual({ peer: '原稿' });
  const key = localStorage.key(0)!;
  localStorage.setItem(key, '{broken');
  expect(() => store.load('a')).toThrow();
  expect(localStorage.getItem(key)).toBe('{broken');
});
