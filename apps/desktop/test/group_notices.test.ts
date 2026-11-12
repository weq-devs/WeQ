import { expect, it } from 'vitest';
import {
  mergeGroupNotices,
  resolveGroupNoticePublishers,
  type GroupBulletinWire,
} from '../src/renderer/src/lib/groupNotices';
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
it('在线与本地正文都解码换行和空格，不把正文作为 HTML 渲染或反复解码', () => {
  const text = '第一行&#10;第二行&nbsp;@合成成员&nbsp;&amp; &lt;b&gt;正文&lt;/b&gt; &amp;#10;';
  const expected = '第一行\n第二行\u00a0@合成成员\u00a0& <b>正文</b> &#10;';
  expect(mergeGroupNotices([], [{ ...online, text }])[0]!.text).toBe(expected);
  expect(mergeGroupNotices([{ ...local, textContent: text }])[0]!.text).toBe(expected);
});
it('公告发布者独立按 UID 或 QQ 号补全，沿用本地备注优先，已退群时回落本地个人资料', () => {
  const entries = mergeGroupNotices(
    [
      { ...local, publisherUid: 'u_member', publisherName: undefined, publisherAvatar: undefined },
      {
        ...local,
        fid: 'left',
        publisherUid: 'u_left',
        publisherName: undefined,
        publisherAvatar: undefined,
      },
    ],
    [{ ...online, noticeId: 'uin', senderId: 10002 }],
  );
  const rows = resolveGroupNoticePublishers(
    entries,
    [{ uid: 'u_member', uin: '10002', card: '群名片', nick: '群内昵称' }],
    [
      { uid: 'u_member', uin: '10002', nick: '本地昵称', remark: '本地备注', avatarUrl: '' },
      { uid: 'u_left', uin: '10003', nick: '已退群昵称', remark: '', avatarUrl: '' },
    ],
  );
  expect(rows.map((row) => row.publisherName)).toEqual(['本地备注', '本地备注', '已退群昵称']);
  expect(rows.map((row) => row.publisherUin)).toEqual(['10002', '10002', '10003']);
  expect(rows.every((row) => row.publisherAvatar?.includes('qlogo.cn'))).toBe(true);
  expect(entries[0]!.publisherName).toBeUndefined();
});
it('保留已有本地显示资料；只有 QQ 号也能生成头像，未知 UID 不伪造 QQ 头像', () => {
  const [known] = resolveGroupNoticePublishers(mergeGroupNotices([local]), [], []);
  expect(known).toMatchObject({
    publisherName: local.publisherName,
    publisherAvatar: local.publisherAvatar,
  });
  const [numeric] = resolveGroupNoticePublishers(mergeGroupNotices([], [online]), [], []);
  expect(numeric!.publisherUin).toBe('10001');
  expect(numeric!.publisherAvatar).toContain('nk=10001');
  const [unknown] = resolveGroupNoticePublishers(
    mergeGroupNotices([{ ...local, publisherAvatar: undefined }]),
    [],
    [],
  );
  expect(unknown!.publisherAvatar).toBeUndefined();
});
it('同一公告保留本地 UID，同时使用在线返回的 QQ 号补全资料', () => {
  const entries = mergeGroupNotices(
    [
      {
        ...local,
        publisherUid: 'u_uncached',
        publisherName: undefined,
        publisherAvatar: undefined,
      },
    ],
    [online],
  );
  const [row] = resolveGroupNoticePublishers(
    entries,
    [],
    [
      {
        uid: 'u_profile',
        uin: String(online.senderId),
        nick: '按 QQ 号找到的昵称',
        remark: '',
        avatarUrl: '',
      },
    ],
  );
  expect(row).toMatchObject({
    publisherUid: 'u_uncached',
    publisherUin: String(online.senderId),
    publisherName: '按 QQ 号找到的昵称',
  });
  expect(row!.publisherAvatar).toContain(`nk=${online.senderId}`);
});
