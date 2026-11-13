import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { FieldHistoryContent } from '../src/renderer/src/components/contactProfile/FieldHistoryContent';
import {
  fieldHistoryItems,
  fieldHistoryMode,
  fieldHistoryText,
  fieldItemChanges,
  fieldPhotoHistoryValue,
  presentFieldHistoryRows,
} from '../src/renderer/src/lib/contactFieldPresentation';
vi.mock('../src/renderer/src/components/MediaSaveControls', () => ({
  MediaSourceSave: () => null,
}));
const roots: ReturnType<typeof createRoot>[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = '';
});

it.each([
  'level',
  'likes',
  'energy',
  'intimacy',
  'commonFriends',
  'memberCount',
  'maxMemberCount',
  'friendCount',
  'activityScore',
  'activeMemberCount',
  'grade',
  'groupLevel',
])('%s 使用数值趋势', (field) => {
  expect(fieldHistoryMode(field)).toBe('trend');
});
it.each([
  'birthday',
  'joinedAt',
  'addedAt',
  'lastSpeakAt',
  'muteUntil',
  'createTime',
  'age',
  'gender',
  'role',
  'freezeState',
  'nick',
  'signature',
  'email',
  'qid',
  'status',
])('%s 不被误画成数值趋势', (field) => {
  expect(fieldHistoryMode(field)).toBe('changes');
});
it.each([
  'labels',
  'school',
  'commonGroups',
  'privileges',
  'marks',
  'dress',
  'questions',
  'relations',
])('%s 按条目比较', (field) => {
  expect(fieldHistoryMode(field)).toBe('collection');
});
it.each(['avatar', 'photos', 'qqShow'])('%s 使用图片历史', (field) => {
  expect(fieldHistoryMode(field)).toBe('gallery');
});
it('日期按已验证的 Unix 秒与北京时间显示，业务枚举、零值和空值不漏', () => {
  expect(fieldHistoryText('joinedAt', 1704038407)).toBe('2024-01-01 00:00:07');
  expect(fieldHistoryText('muteUntil', 0)).toBe('未禁言');
  expect(fieldHistoryText('memberCount', 0)).toBe('0 人');
  expect(fieldHistoryText('age', 0)).toBe('未设置');
  expect(fieldHistoryText('gender', 2)).toBe('女');
  expect(fieldHistoryText('role', 1)).toBe('群主');
  expect(fieldHistoryText('occupation', 13)).toBe('学生');
  expect(fieldHistoryText('bloodType', 3)).toBe('O型');
  expect(fieldHistoryText('birthday', { birthMonth: 2, birthDay: 3 })).toBe('2 月 3 日');
  expect(fieldHistoryText('region', { country: '中国', province: '上海', city: '上海' })).toBe(
    '中国 · 上海',
  );
  expect(fieldHistoryText('signature', '')).toBe('已清空');
  expect(fieldHistoryText('direction', 'outgoing')).toBe('我添加对方');
  expect(fieldHistoryText('status', { type: 70, subType: 0 })).toBe('勿扰');
  expect(
    fieldHistoryText('status', { type: 10, subType: 2000, customStatus: { text: '学习中' } }),
  ).toBe('在线 · 学习中');
  expect(fieldHistoryText('status', { type: 99 })).toBe('状态编号 99');
});
it('群标签合并去重，集合识别新增、改名与不再出现，忽略列表次序', () => {
  expect(
    fieldHistoryItems('labels', { labels: ['音乐'], customLabels: ['音乐', '同学'] }).map(
      (r) => r.title,
    ),
  ).toEqual(['音乐', '同学']);
  const before = fieldHistoryItems('commonGroups', [
    { groupCode: '1', name: '旧名' },
    { groupCode: '2', name: '旧群' },
  ]);
  const current = fieldHistoryItems('commonGroups', [
    { groupCode: '3', name: '新群' },
    { groupCode: '1', name: '新名' },
  ]);
  const changes = fieldItemChanges(current, before);
  expect(changes.added.map((r) => r.title)).toEqual(['新群']);
  expect(changes.removed.map((r) => r.title)).toEqual(['旧群']);
  expect(changes.changed[0]?.before.title).toBe('旧名');
  expect(changes.changed[0]?.after.title).toBe('新名');
  expect(fieldItemChanges([...current].reverse(), current)).toEqual({
    added: [],
    removed: [],
    changed: [],
  });
});
it('本机学校的简略名称升级为完整教育经历显示为变更，不误报同校新增和退出', () => {
  const before = fieldHistoryItems('school', '示例学校');
  const after = fieldHistoryItems('school', [{ index: 0, schoolName: '示例学校', degree: 6 }]);
  const diff = fieldItemChanges(after, before);
  expect(diff.added).toEqual([]);
  expect(diff.removed).toEqual([]);
  expect(diff.changed).toHaveLength(1);
  expect(diff.changed[0]?.after.detail).toBe('本科');
});
it('互动标识只比较本人已点亮或佩戴项目，新增未点亮目录项不算获得新标识', () => {
  const mark = { id: '1', name: '火花', isLightup: true, isWearing: false, level: 1 };
  const rows = [
    { categories: [{ marks: [mark, { id: '2', name: '未点亮', isLightup: false }] }] },
    { categories: [{ marks: [mark] }] },
  ].map((value, i) => ({ id: i + 1, first_at: 200 - i * 100, last_at: 200 - i * 100, value }));
  expect(fieldHistoryItems('marks', rows[0]!.value)).toHaveLength(1);
  expect(presentFieldHistoryRows('marks', rows)).toHaveLength(1);
});
it('实际教育、装扮和互动标识结构转成业务条目，不展示请求及图片元数据', () => {
  expect(
    fieldHistoryItems('school', [
      { index: 0, schoolName: '示例学校', degree: 6, enrollmentYear: 2020, graduationYear: 2024 },
    ])[0],
  ).toMatchObject({ title: '示例学校', detail: '本科 · 2020 年入学 · 2024 年毕业' });
  expect(
    fieldHistoryItems('dress', {
      targetUin: '10001',
      items: [{ appId: 15, itemId: 0, kind: '气泡', name: '默认' }],
    })[0],
  ).toMatchObject({ title: '气泡', detail: '默认 · 默认' });
  const value = {
    categories: [
      {
        marks: [
          {
            id: '1',
            name: '火花',
            level: 2,
            isLightup: true,
            count: 7,
            isWearing: true,
            iconUrl: 'https://example.invalid/icon.png',
          },
        ],
      },
    ],
  };
  expect(fieldHistoryItems('marks', value)[0]).toMatchObject({
    title: '火花',
    detail: '已点亮 · 2 级 · 进度 7 · 佩戴中',
  });
});
it('只从同一原始版本补回相同照片编号的 URL，不修改旧索引或借用当前照片', () => {
  const indexed = [{ photoId: 'old' }, { photoId: 'missing' }];
  const raw = {
    extInfo: {
      album: [
        { photoId: 'old', urls: [{ size: 1, url: 'https://example.invalid/old.png' }] },
        { photoId: 'new', urls: [{ url: 'https://example.invalid/new.png' }] },
      ],
    },
  };
  expect(fieldPhotoHistoryValue(indexed, raw)).toEqual([
    { photoId: 'old', urls: raw.extInfo.album[0]!.urls },
    { photoId: 'missing' },
  ]);
  expect(indexed).toEqual([{ photoId: 'old' }, { photoId: 'missing' }]);
  expect(fieldPhotoHistoryValue(indexed, {})).toBe(indexed);
});
it('本机旧装扮快照的头像和链接变化合并为同一业务版本，保留 A→B→A 与首次/最近观察时间', () => {
  const a = { items: [{ appId: 15, itemId: 1, kind: '气泡', name: 'A' }] };
  const b = { items: [{ appId: 15, itemId: 2, kind: '气泡', name: 'B' }] };
  const rows = [a, { ...a, avatarUrl: 'https://example.invalid/avatar' }, b, a].map((value, i) => ({
    id: 4 - i,
    first_at: 400 - i * 100,
    last_at: 450 - i * 100,
    value,
  }));
  const result = presentFieldHistoryRows('dress', rows);
  expect(result).toHaveLength(3);
  expect(result[0]).toMatchObject({ first_at: 300, last_at: 450 });
  expect(result.map((r) => fieldHistoryItems('dress', r.value)[0]?.title)).toEqual([
    '气泡',
    '气泡',
    '气泡',
  ]);
  expect(rows[0]!.first_at).toBe(400);
});

async function render(field: string, values: unknown[], hasOlder = false) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () =>
    root.render(
      h(FieldHistoryContent, {
        field,
        label: '测试',
        hasOlder,
        rows: values.map((value, i) => ({
          id: i + 1,
          first_at: 1704038400000 - i * 86400000,
          last_at: 1704038400100 - i * 86400000,
          value,
        })),
      }),
    ),
  );
  return host;
}
it('数值趋势保留零、负向变化和准确明细；未知值断开线段，不替换为零', async () => {
  const host = await render('memberCount', [0, null, 20, 10]);
  expect(host.querySelector('svg[role="img"]')).not.toBeNull();
  expect(host.textContent).toContain('0 人');
  expect(host.textContent).toContain('+10');
  expect(host.querySelectorAll('circle')).toHaveLength(3);
  expect(
    host.querySelector('path.weq-field-chart-line')?.getAttribute('d')?.split('M'),
  ).toHaveLength(3);
});
it('生日与枚举展示变更，A → B → A 不丢记录，有更早页时不冒称最早', async () => {
  const host = await render('gender', [1, 2, 1], true);
  expect(host.querySelector('svg[role="img"]')).toBeNull();
  expect(host.querySelectorAll('.weq-field-records > li')).toHaveLength(3);
  expect(host.querySelectorAll('.weq-field-previous')).toHaveLength(2);
  expect(host.textContent).not.toContain('最早记录');
  expect(host.textContent).toContain('最近观察');
});
it('空记录明确显示，单一有效数值不画趋势，图片失败保留记录', async () => {
  const empty = await render('likes', []);
  expect(empty.textContent).toContain('暂无这项资料的历史记录');
  const single = await render('likes', [0]);
  expect(single.querySelector('svg[role="img"]')).toBeNull();
  const photo = await render('photos', [
    [{ photoId: 'p', urls: [{ url: 'https://example.invalid/p.png' }] }],
  ]);
  expect(photo.querySelector('img')?.src).toContain('album');
  await act(async () => photo.querySelector('img')!.dispatchEvent(new Event('error')));
  expect(photo.textContent).toContain('图片暂不可用');
});
