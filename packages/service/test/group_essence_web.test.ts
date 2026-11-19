import { afterEach, beforeEach, expect, it } from 'vitest';
import { getGroupEssence, getGroupEssencePage } from '../src/account/web/group_essence';
import { stubWebFetch } from './support/web-fetch';

/**
 * 群精华的响应校验。
 *
 * 实现收编进 `@weqbot/protocol` 之后，kernel 直接调全局 `fetch`，所以这里从
 * 最底层拦（原先 mock 的是 WeQ 的 `./http`，那条路径已不再被业务使用）。
 */
let web = stubWebFetch();

const credential = { uin: '10000', skey: 'fixture', pskey: 'fixture' };

beforeEach(() => {
  web = stubWebFetch();
});
afterEach(() => web.restore());

it('业务失败、缺少数据和无效列表不降级为空精华', async () => {
  for (const raw of [
    { retcode: 1, data: {} },
    { retcode: 0 },
    { retcode: 0, data: { is_end: false } },
  ]) {
    web.reply({ text: JSON.stringify(raw) });
    await expect(getGroupEssence(credential, '123')).rejects.toThrow();
  }
});

it('只信任首个分页的明确 is_end，短页和后续空页不能代表完整快照', async () => {
  web.reply({ text: JSON.stringify({ retcode: 0, data: { is_end: true, msg_list: null } }) });
  await expect(getGroupEssencePage(credential, '123')).resolves.toEqual({
    messages: [],
    complete: true,
  });
  await expect(getGroupEssencePage(credential, '123', 1)).resolves.toEqual({
    messages: [],
    complete: false,
  });
  web.reply({ text: JSON.stringify({ retcode: 0, data: { is_end: false, msg_list: [] } }) });
  await expect(getGroupEssencePage(credential, '123')).resolves.toEqual({
    messages: [],
    complete: false,
  });
  web.reply({ text: JSON.stringify({ retcode: 0, data: { is_end: true, msg_list: [null] } }) });
  await expect(getGroupEssencePage(credential, '123')).resolves.toEqual({
    messages: [],
    complete: false,
  });
});
