import { expect, it, vi } from 'vitest';
const query = vi.hoisted(() => vi.fn());
vi.mock('../src/account/web/http', () => ({ webRequestJson: query, WEB_READ_RETRY: {} }));
import { getGroupEssence, getGroupEssencePage } from '../src/account/web/group_essence';

const credential = { uin: '10000', skey: 'fixture', pskey: 'fixture' };

it('业务失败、缺少数据和无效列表不降级为空精华', async () => {
  for (const raw of [
    { retcode: 1, data: {} },
    { retcode: 0 },
    { retcode: 0, data: { is_end: false } },
  ]) {
    query.mockResolvedValueOnce(raw);
    await expect(getGroupEssence(credential, '123')).rejects.toThrow();
  }
});

it('只信任首个分页的明确 is_end，短页和后续空页不能代表完整快照', async () => {
  query.mockResolvedValue({ retcode: 0, data: { is_end: true, msg_list: null } });
  await expect(getGroupEssencePage(credential, '123')).resolves.toEqual({
    messages: [],
    complete: true,
  });
  await expect(getGroupEssencePage(credential, '123', 1)).resolves.toEqual({
    messages: [],
    complete: false,
  });
  query.mockResolvedValue({ retcode: 0, data: { is_end: false, msg_list: [] } });
  await expect(getGroupEssencePage(credential, '123')).resolves.toEqual({
    messages: [],
    complete: false,
  });
  query.mockResolvedValue({ retcode: 0, data: { is_end: true, msg_list: [null] } });
  await expect(getGroupEssencePage(credential, '123')).resolves.toEqual({
    messages: [],
    complete: false,
  });
});
