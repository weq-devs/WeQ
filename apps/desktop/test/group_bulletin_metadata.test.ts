import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { GroupBulletinList } from '../src/renderer/src/components/GroupBulletinList';
import type { GroupNoticeEntry } from '../src/renderer/src/lib/groupNotices';

it.each([
  { date: '2026/10/19', readNum: 20, noticeId: 'online', labels: ['2026/10/19', '20 人已读'] },
  {
    date: '2026/10/19',
    readNum: undefined,
    noticeId: undefined,
    labels: ['2026/10/19', '历史记录'],
  },
  { date: '', readNum: undefined, noticeId: undefined, labels: ['历史记录'] },
  { date: '', readNum: 0, noticeId: 'online', labels: ['0 人已读'] },
  { date: '', readNum: undefined, noticeId: 'online', labels: [] },
])('公告信息独立排列，不生成圆点或空项：$labels', ({ labels, ...metadata }) => {
  const entry: GroupNoticeEntry = {
    key: 'synthetic',
    publisherUid: 'u_peer',
    text: '公告',
    images: [],
    ...metadata,
  };
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(
    h(GroupBulletinList, {
      entries: [entry],
      groupCode: '123456',
      groupName: '测试群',
      tools: () => null,
      onContextMenu: () => {},
    }),
  );
  const row = host.querySelector('.group-bulletin-date')!;
  expect(Array.from(row.children, (node) => node.textContent)).toEqual(labels);
  expect(row.textContent).not.toContain('·');
  expect(row.textContent).not.toContain('本地记录');
});
