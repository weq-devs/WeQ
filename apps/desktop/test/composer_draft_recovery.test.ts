import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Storage } from 'happy-dom';
import { createComposerDraftRecovery } from '../src/renderer/src/lib/composerDraftRecovery';
import { localDraftToWrite, setLocalDraft } from '@weq/service/draft-edit';
import { composerTextToElements } from '../src/renderer/src/im-template/template/draftElements';

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

it.each(['\n', '\n\n', '   \t\r\n'])('纯空白输入 %j 在重启前后和写回 QQ 时均原样保留', (body) => {
  const first = createComposerDraftRecovery(localStorage);
  first.write('a', 'peer', body);
  const pending = setLocalDraft({}, 'peer', body);
  expect(pending).toEqual({ peer: body });
  const restarted = createComposerDraftRecovery(localStorage);
  expect(restarted.load('a')).toEqual(pending);
  expect(composerTextToElements(localDraftToWrite(restarted.load('a'), 'peer'))).toEqual([
    { kind: 'text', textContent: body },
  ]);
  // 正常保存确认使用原文，也必须清除恢复快照。
  first.confirm('a', 'peer', localDraftToWrite(pending, 'peer'));
  expect(restarted.load('a')).toEqual({});
});

it('已有纯换行快照与正文首尾空行均保留，仅确认相同原文后删除', () => {
  const first = createComposerDraftRecovery(localStorage);
  first.write('a', 'peer', '临时正文');
  const key = localStorage.key(0)!;
  localStorage.setItem(key, JSON.stringify({ version: 1, body: '\n' }));
  const restarted = createComposerDraftRecovery(localStorage);
  expect(restarted.load('a')).toEqual({ peer: '\n' });
  restarted.confirm('a', 'peer', '');
  expect(restarted.load('a')).toEqual({ peer: '\n' });
  restarted.confirm('a', 'peer', '\n');
  expect(localStorage.getItem(key)).toBeNull();
  const body = '\n正文\n\n';
  restarted.write('a', 'peer', body);
  expect(restarted.load('a')).toEqual({ peer: body });
  restarted.confirm('a', 'peer', '');
  expect(restarted.load('a')).toEqual({ peer: body });
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
it('旧按 QQ 号保存的恢复稿只迁给首个配置，不覆盖新稿，也不串入同号备份', () => {
  const store = createComposerDraftRecovery(localStorage);
  store.write('10001', 'peer', '旧稿原件');
  store.write('["10001","source-a"]', 'peer', '当前配置新稿');
  store.migrate('10001', '["10001","source-a"]');
  expect(store.load('["10001","source-a"]')).toEqual({ peer: '当前配置新稿' });
  store.migrate('10001', '["10001","source-b"]');
  expect(store.load('["10001","source-b"]')).toEqual({});
  expect(store.load('10001')).toEqual({ peer: '旧稿原件' });
});
