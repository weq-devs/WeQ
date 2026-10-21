import { expect, it } from 'vitest';
import { mergeGroupNotices, type GroupBulletinWire } from '../src/renderer/src/lib/groupNotices';
const local: GroupBulletinWire = {
  fid: 'notice-a',
  publisherUid: 'uid-a',
  publisherName: '合成发布者',
  publisherAvatar: 'synthetic-avatar',
  textContent: '本地 &amp; 正文',
  ctime: '2026-10-20 01:30:00',
  msgTime: '',
  images: [{ id: 'old-image', width: 10, height: 20 }],
};
const online = {
  noticeId: 'notice-a',
  senderId: 10001,
  publishTime: 1,
  text: '在线正文',
  images: [{ id: 'new-image', width: 20, height: 10 }],
  readNum: 0,
};
it('仅按公告 ID 合并，在线正文和图片更新同一项，保留本地发布者资料', () => {
  const result = mergeGroupNotices([local], [online, online]);
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({
    noticeId: online.noticeId,
    text: online.text,
    images: online.images,
    publisherUid: local.publisherUid,
    publisherName: local.publisherName,
    readNum: 0,
  });
  expect(local.textContent).toBe('本地 &amp; 正文');
});
it('在线空页或部分页不删除本地历史，也不按相同正文误认另一条公告', () => {
  expect(mergeGroupNotices([local], [])[0]).toMatchObject({
    text: '本地 & 正文',
    date: '2026/10/20',
  });
  expect(mergeGroupNotices([local], [])[0]!.noticeId).toBeUndefined();
  expect(
    mergeGroupNotices([local], [{ ...online, noticeId: 'notice-b', text: local.textContent }]),
  ).toHaveLength(2);
});
it('本地重复 ID 不生成重复项，无 ID 内容不被误去重或赋予删除目标', () => {
  const rows = mergeGroupNotices([local, local, { ...local, fid: '' }, { ...local, fid: '' }]);
  expect(rows).toHaveLength(3);
  expect(new Set(rows.map((row) => row.key)).size).toBe(3);
  expect(rows.every((row) => !row.noticeId)).toBe(true);
});
it('远端秒级时间用北京时间，本地无时区日期保留原值，异常时间不崩溃', () => {
  expect(
    mergeGroupNotices(
      [],
      [{ ...online, publishTime: Date.parse('2026-10-19T18:00:00Z') / 1000 }],
    )[0]!.date,
  ).toBe('2026/10/20');
  expect(mergeGroupNotices([local])[0]!.date).toBe('2026/10/20');
  expect(mergeGroupNotices([], [{ ...online, publishTime: Number.MAX_VALUE }])[0]!.date).toBe('');
});
