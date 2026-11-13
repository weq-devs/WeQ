// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AccountServices } from '../src/main/context/app_context';
const state = vi.hoisted(() => ({ root: '' }));
vi.mock('../src/main/context/app_context', () => ({
  getAppContext: () => ({ platform: { appDataRoot: () => state.root } }),
}));
import { recentReactions, setReactionWithRecent } from '../src/main/recent_reactions';
beforeEach(() => {
  state.root = mkdtempSync(join(tmpdir(), 'weq-reaction-outcome-'));
});
afterEach(() => rmSync(state.root, { recursive: true, force: true }));
const input = { groupId: '10000', sequence: 1, code: '76', isSet: true };
function service(id = 'fixture') {
  const set = vi.fn(async () => {});
  const services = {
    accountConfig: { getRecord: () => ({ configId: id }) },
    interaction: { setMessageReaction: set },
  } as unknown as AccountServices;
  return { set, services };
}
it('成功添加才记录，取消不重排；账号与配置来源独立', async () => {
  const { services } = service('source-a');
  await setReactionWithRecent(services, input, () => {});
  await setReactionWithRecent(services, { ...input, code: '14', isSet: false }, () => {});
  expect(recentReactions(services).list()).toEqual(['76']);
  expect(recentReactions(service('source-b').services).list()).toEqual([]);
});
it('请求失败不记录；账号切换后的迟到成功也不写新来源', async () => {
  const { services, set } = service();
  set.mockRejectedValueOnce(new Error('合成网络错误'));
  await expect(setReactionWithRecent(services, input, () => {})).rejects.toThrow('合成网络错误');
  expect(recentReactions(services).list()).toEqual([]);
  await expect(
    setReactionWithRecent(services, input, () => {
      throw new Error('账号已切换');
    }),
  ).rejects.toThrow('账号已切换');
  expect(recentReactions(services).list()).toEqual([]);
});
