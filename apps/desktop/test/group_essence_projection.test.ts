import { expect, it } from 'vitest';
import {
  projectGroupEssence,
  hasCompleteEssenceSnapshot,
} from '../src/renderer/src/lib/groupEssenceProjection';

const local = {
  msgSeq: 42,
  msgRandom: 77,
  senderNick: '合成成员',
  operatorNick: '合成管理员',
  timestamp: 1_700_000_000,
  setStatus: 1,
};

it('本地精华保留真实 random，Web 未返回内容时仍可取消', () => {
  expect(projectGroupEssence([local], [])[0]).toMatchObject({
    msgSeq: 42,
    msgRandom: 77,
    active: true,
  });
  expect(projectGroupEssence([{ ...local, msgRandom: 0 }], [])[0]?.msgRandom).toBe(0);
});
it('本地已取消历史不能被旧的精华序号缓存或 Web 记录冒充为当前精华', () => {
  const web = { ...local, senderTime: local.timestamp, content: [{ type: 1, text: '正文' }] };
  expect(projectGroupEssence([{ ...local, setStatus: 2 }], [web])[0]?.active).toBe(false);
});
it('按序号合并 Web 正文，优先原始本地定位，在线独有记录也可展示', () => {
  const web = {
    ...local,
    msgRandom: 88,
    senderTime: local.timestamp,
    content: [{ type: 1, text: '正文' }],
  };
  const rows = projectGroupEssence([local], [web, { ...web, msgSeq: 43 }]);
  expect(rows).toHaveLength(2);
  expect(rows.find((row) => row.msgSeq === 42)).toMatchObject({
    msgRandom: 77,
    content: web.content,
  });
  expect(rows.find((row) => row.msgSeq === 43)).toMatchObject({ msgRandom: 88, active: true });
  expect(projectGroupEssence([{ ...local, msgRandom: undefined }], [web])[0]?.msgRandom).toBe(88);
});

it('完整在线快照确认取消时，不再被旧本地有效记录重新插回；部分分页不作此推断', () => {
  expect(projectGroupEssence([local], [], true)[0]?.active).toBe(false);
  expect(projectGroupEssence([local], [], false)[0]?.active).toBe(true);
  const online = { ...local, senderTime: local.timestamp };
  expect(projectGroupEssence([{ ...local, setStatus: 2 }], [online], true)[0]?.active).toBe(true);
});

it('只有成功、完整且不旧于本地读取的在线快照才可覆盖，短页不等于完整', () => {
  const snapshot = { success: true, complete: true, updatedAt: 20, localUpdatedAt: 10 };
  expect(hasCompleteEssenceSnapshot(snapshot)).toBe(true);
  expect(hasCompleteEssenceSnapshot({ ...snapshot, success: false })).toBe(false);
  expect(hasCompleteEssenceSnapshot({ ...snapshot, complete: false })).toBe(false);
  expect(hasCompleteEssenceSnapshot({ ...snapshot, updatedAt: 0 })).toBe(false);
  expect(hasCompleteEssenceSnapshot({ ...snapshot, localUpdatedAt: 21 })).toBe(false);
});
