import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ProfileExtras, ProfileLabelAlbum } from '../src/renderer/src/components/ProfileExtras';
import type { PersonalityLabel } from '@weq/protocol';
import { ProfileNavigationContext } from '../src/renderer/src/lib/profileNavigation';

const openProfile = vi.fn();

const state = vi.hoisted(() => ({
  online: true,
  account: '10001',
  target: '10002',
  filter: '',
  energy: vi.fn(),
  signatures: vi.fn(),
  labels: vi.fn(),
  photos: vi.fn(),
  questions: vi.fn(),
  education: vi.fn(),
  next: vi.fn(),
}));
vi.mock('../src/renderer/src/hooks/useQQWriteSession', () => ({
  useQQWriteSession: () => ({
    available: state.online,
    binding: { expectedAccountUin: state.account, expectedAccountConfigId: 'source' },
  }),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    account: {
      profileExtras: {
        energy: { useQuery: state.energy },
        educationHistory: { useQuery: state.education },
        signatureHistory: { useInfiniteQuery: state.signatures },
        signatureLikes: { useInfiniteQuery: () => result() },
        personalityLabels: { useQuery: state.labels },
        personalityPhotos: { useInfiniteQuery: state.photos },
        anonymousQuestions: { useInfiniteQuery: state.questions },
      },
    },
  },
}));
vi.mock('../src/renderer/src/components/MediaPreview', () => ({
  MediaPreview: () => h('div', { role: 'dialog', 'aria-label': '标签照片预览' }),
}));
function result(data?: unknown) {
  return {
    data,
    isFetching: false,
    error: null,
    hasNextPage: false,
    isFetchNextPageError: false,
    fetchNextPage: state.next,
    refetch: vi.fn(),
  };
}
const page = {
  targetUin: '10002',
  items: [
    {
      id: 's1',
      text: '合成历史签名',
      action: null,
      data: null,
      location: '合成位置',
      createdAt: 100,
    },
  ],
  nextCursor: 99,
  hasMore: true,
  paginationError: null,
};
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
async function render(section: 'signature' | 'details' = 'details') {
  await act(async () => root.render(h(ProfileExtras, { uin: state.target, section })));
}
async function click(text: string) {
  const button = [...document.querySelectorAll('button')].find((button) =>
    button.textContent?.includes(text),
  );
  expect(button).toBeTruthy();
  await act(async () => button!.click());
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state.online = true;
  state.account = '10001';
  state.target = '10002';
  vi.clearAllMocks();
  state.energy.mockReturnValue(result({ targetUin: '10002', score: 0, level: null }));
  state.education.mockReturnValue(result({ targetUin: '10002', items: [] }));
  state.signatures.mockReturnValue({ ...result({ pages: [page] }), hasNextPage: true });
  state.labels.mockReturnValue(result({ targetUin: '10002', labels: [] }));
  state.photos.mockReturnValue(result());
  state.questions.mockImplementation((input) => {
    state.filter = input.filter;
    return result({ pages: [{ ...page, items: [] }] });
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
it('零能量正常显示，未展开不请求列表', async () => {
  await render();
  expect(host.textContent).toContain('QQ 能量值0');
  expect(state.signatures).not.toHaveBeenCalled();
  expect(state.labels).not.toHaveBeenCalled();
  expect(state.questions).not.toHaveBeenCalled();
  expect(state.education).not.toHaveBeenCalled();
});
it('接口返回能量等级时仍只显示能量值', async () => {
  state.energy.mockReturnValue(result({ targetUin: '10002', score: 321, level: 987 }));
  await render();
  expect(host.textContent).toContain('QQ 能量值321');
  expect(host.textContent).not.toContain('能量等级');
  expect(host.textContent).not.toContain('987');
});
it('签名入口按需在触发点旁打开无遮罩详情，保留时间地点并支持翻页', async () => {
  await render('signature');
  expect(state.signatures).not.toHaveBeenCalled();
  await click('历史签名');
  expect(document.querySelector('.weq-extras-dialog')?.parentElement?.classList).toContain(
    'is-anchored-popover',
  );
  expect(document.querySelector('[aria-modal="true"]')).toBeNull();
  expect(host.querySelector('button')?.getAttribute('aria-haspopup')).toBe('dialog');
  expect(host.querySelector('button')?.getAttribute('aria-expanded')).toBe('true');
  expect(document.body.textContent).toContain('合成历史签名');
  expect(document.body.textContent).toContain('合成位置');
  await click('加载更多');
  expect(state.next).toHaveBeenCalledTimes(1);
});
it('重复点击签名入口收起历史，关闭按钮同样有效', async () => {
  await render('signature');
  await click('历史签名');
  await click('历史签名');
  expect(document.querySelector('.weq-extras-dialog')).toBeNull();
  expect(host.querySelector('button')?.getAttribute('aria-expanded')).toBe('false');
  await click('历史签名');
  await act(async () =>
    document.querySelector<HTMLButtonElement>('[aria-label="关闭资料详情"]')!.click(),
  );
  expect(document.querySelector('.weq-extras-dialog')).toBeNull();
});
it('签名互动复用空间操作栏和评论排版，点赞名单通过悬浮面板展示', async () => {
  state.signatures.mockReturnValue(
    result({
      pages: [
        {
          ...page,
          items: [
            {
              ...page.items[0],
              likes: '2',
              likeUsers: [{ id: '10003', uin: '10003', name: '合成点赞人' }],
              commentItems: [
                {
                  id: 'c1',
                  fromUin: '10003',
                  fromName: '合成评论者',
                  text: '合成评论正文',
                  time: 100,
                },
              ],
            },
          ],
        },
      ],
    }),
  );
  await render('signature');
  await click('历史签名');
  expect(document.querySelector('.weq-signature-interactions .weq-qzn-actions')).not.toBeNull();
  expect(document.querySelector('.weq-qzn-actions')?.textContent).toContain('评论');
  expect(document.body.textContent).not.toContain('点赞人');
  const like = document.querySelector<HTMLButtonElement>('[aria-label="点赞签名"]')!;
  await act(async () => like.focus());
  expect(
    document.querySelector('.weq-qzn-like-popover .weq-qzn-like-users')?.textContent,
  ).toContain('合成点赞人');
  await click('评论');
  expect(document.querySelector('.weq-qzn-interaction .weq-qzn-comment p')?.textContent).toBe(
    '合成评论正文',
  );
  expect(document.querySelector('.weq-qzn-comment-meta time')).not.toBeNull();
  expect(document.querySelector('.weq-qzn-comment-composer .weq-set-iconbtn')).not.toBeNull();
});
it('切账号或切目标关闭旧详情，不带入旧分页', async () => {
  await render('signature');
  await click('历史签名');
  state.account = '10003';
  await render('signature');
  expect(document.querySelector('[aria-label="关闭资料详情"]')).toBeNull();
  await click('历史签名');
  state.target = '10004';
  await render('signature');
  expect(document.querySelector('[aria-label="关闭资料详情"]')).toBeNull();
});
it('离线时查询禁用，详情空态不伪装成空列表', async () => {
  state.online = false;
  state.energy.mockReturnValue(result());
  state.signatures.mockReturnValue(result());
  await render('signature');
  await click('历史签名');
  expect(document.body.textContent).toContain('暂不可在线读取');
  expect(state.signatures.mock.calls.at(-1)?.[1].enabled).toBe(false);
});
it('自己的问答可切筛选，他人固定已回答', async () => {
  await render();
  await click('匿问我答');
  expect(state.filter).toBe('answered');
  expect(document.querySelector('[aria-label="问答显示范围"]')).toBeNull();
  state.target = '10001';
  await render();
  await click('匿问我答');
  expect(state.filter).toBe('all');
  await click('已回答');
  expect(state.filter).toBe('answered');
});
it('未返回互动数量的问答保留可辨认的展开入口', async () => {
  state.questions.mockReturnValue(
    result({
      pages: [
        {
          ...page,
          items: [
            {
              id: 'q1',
              question: '问题',
              answer: null,
              askedAt: 123,
              answeredAt: null,
              likes: null,
              comments: null,
            },
          ],
        },
      ],
    }),
  );
  await render();
  await click('匿问我答');
  const button = document.querySelector<HTMLButtonElement>('.weq-profile-question-open');
  expect(button?.textContent).toContain('查看互动');
  expect(button?.getAttribute('aria-label')).toBe('查看问答互动');
});
it('扩展资料不再保留全部标签的聚合入口', async () => {
  state.energy.mockReturnValue({ ...result(), error: new Error('暂不可用') });
  await render();
  expect(host.textContent).toContain('暂不可读取');
  expect(host.textContent).not.toContain('标签相册');
  expect(state.labels).not.toHaveBeenCalled();
});
const label: PersonalityLabel = {
  id: 'label',
  text: '合成相册',
  cover: null,
  photoCount: 1,
  photoCursor: null,
  photos: [{ id: 'p', url: 'https://p.qpic.cn/fixture', uploadedAt: null, likes: null }],
  likes: null,
};
async function renderAlbum(value = label) {
  await act(async () =>
    root.render(
      h(
        ProfileNavigationContext.Provider,
        { value: openProfile },
        h(ProfileLabelAlbum, {
          key: `${state.account}:${state.target}`,
          input: {
            uin: state.target,
            expectedAccountUin: state.account,
            expectedAccountConfigId: 'source',
          },
          online: state.online,
          label: value,
          refresh: async () => {},
        }),
      ),
    ),
  );
}
it('标签点赞头像昵称共用一个名片入口，末尾使用总数且不带点赞按钮', async () => {
  await renderAlbum({
    ...label,
    likes: '28',
    likeUsers: [
      { id: '10003', uin: '10003', name: '合成点赞人', time: null },
      { id: '10004', uin: '10004', name: null, time: null },
    ],
  });
  await click('合成相册');
  const likes = document.querySelector('[aria-label="标签点赞列表"]')!;
  expect(likes.classList.contains('weq-qzn-like-users')).toBe(true);
  expect(
    [...likes.querySelectorAll('.weq-profile-label-like-name')].map((node) => node.textContent),
  ).toEqual(['合成点赞人', '10004']);
  expect(likes.querySelectorAll('.weq-avatar-img, .weq-avatar-fallback')).toHaveLength(2);
  expect(likes.querySelector('.weq-profile-label-like-total')?.textContent).toBe('等 28 人点赞');
  expect(likes.querySelector('span[title]')?.getAttribute('title')).toBe('合成点赞人 (10003)');
  expect(likes.querySelectorAll('button')).toHaveLength(2);
  const person = likes.querySelector<HTMLButtonElement>('[aria-label="查看 合成点赞人 的名片"]')!;
  expect(person.querySelector('.weq-avatar-img, .weq-avatar-fallback')).not.toBeNull();
  expect(person.querySelector('.weq-profile-label-like-name')?.textContent).toBe('合成点赞人');
  await act(async () =>
    person.querySelector<HTMLElement>('.weq-avatar-img, .weq-avatar-fallback')!.click(),
  );
  await act(async () => person.querySelector<HTMLElement>('.weq-profile-label-like-name')!.click());
  expect(openProfile).toHaveBeenCalledTimes(2);
  for (const [user] of openProfile.mock.calls) {
    expect(user).toMatchObject({
      identityLabel: 'QQ',
      identityValue: '10003',
      displayName: '合成点赞人',
    });
  }
  expect(likes.querySelector('[aria-pressed]')).toBeNull();
  expect(document.querySelector('.weq-label-album .weq-qzn-actions')).toBeNull();
});
it('标签无点赞名单仍显示真实总数，未知总数不使用摘要人数冒充总数', async () => {
  await renderAlbum({ ...label, likes: '0' });
  await click('合成相册');
  expect(document.querySelector('.weq-profile-label-like-total')?.textContent?.trim()).toBe(
    '0 人点赞',
  );
  await renderAlbum({
    ...label,
    likeUsers: [{ id: '10003', uin: '10003', name: '合成点赞人', time: null }],
  });
  expect(document.querySelector('.weq-profile-label-like-total')?.textContent).toBe('等人点赞');
  await renderAlbum();
  expect(document.querySelector('[aria-label="标签点赞列表"]')).toBeNull();
});
it('已结束的照片首批直接展示，点击复用预览', async () => {
  await renderAlbum();
  expect(state.photos).not.toHaveBeenCalled();
  await click('合成相册');
  expect(document.querySelector('.weq-overlay-layer.is-popover')).toBeTruthy();
  expect(document.querySelector('[aria-modal="true"]')).toBeNull();
  expect(document.body.textContent).not.toContain('全部标签');
  expect(state.photos.mock.calls.at(-1)?.[1].enabled).toBe(false);
  const photo = document.querySelector<HTMLButtonElement>('[aria-label="查看第 1 张照片"]');
  await act(async () => photo!.click());
  expect(document.querySelector('[aria-label="标签照片预览"]')).toBeTruthy();
});
it('重复点击标签收起相册，关闭按钮也可收起', async () => {
  await renderAlbum();
  await click('合成相册');
  expect(host.querySelector('button')?.getAttribute('aria-expanded')).toBe('true');
  await click('合成相册');
  expect(document.querySelector('.weq-label-album')).toBeNull();
  await click('合成相册');
  await act(async () =>
    document.querySelector<HTMLButtonElement>('[aria-label="关闭标签相册"]')!.click(),
  );
  expect(document.querySelector('.weq-label-album')).toBeNull();
});
it('空相册不请求照片，未知总数的相册按需读取并保留首批', async () => {
  await renderAlbum({ ...label, photoCount: 0, photos: [] });
  await click('合成相册');
  expect(document.body.textContent).toContain('暂无照片');
  expect(state.photos.mock.calls.at(-1)?.[1].enabled).toBe(false);
  await renderAlbum({ ...label, photoCount: null });
  expect(state.photos.mock.calls.at(-1)?.[1].enabled).toBe(true);
  expect(document.querySelector('[aria-label="查看第 1 张照片"]')).toBeTruthy();
});
it('离线保留首批照片，缺少照片时说明不能在线读取', async () => {
  state.online = false;
  await renderAlbum({ ...label, photoCount: 3 });
  await click('合成相册');
  expect(state.photos.mock.calls.at(-1)?.[1].enabled).toBe(false);
  expect(document.querySelector('[aria-label="查看第 1 张照片"]')).toBeTruthy();
  await renderAlbum({ ...label, photoCount: null, photos: [] });
  expect(document.body.textContent).toContain('暂不可在线读取');
});
it('后续照片失败保留首批，可重试且使用当前标签游标', async () => {
  const refetch = vi.fn();
  state.photos.mockReturnValue({ ...result(), error: new Error('暂不可读'), refetch });
  await renderAlbum({ ...label, photoCount: 3, photoCursor: 'cursor' });
  await click('合成相册');
  expect(state.photos.mock.calls.at(-1)?.[0].labelId).toBe(label.id);
  expect(state.photos.mock.calls.at(-1)?.[1].initialCursor).toBe('cursor');
  expect(document.querySelector('[aria-label="查看第 1 张照片"]')).toBeTruthy();
  await click('重试本页');
  expect(refetch).toHaveBeenCalledOnce();
});
it('切账号或联系人卸载旧相册', async () => {
  await renderAlbum();
  await click('合成相册');
  state.account = '10003';
  await renderAlbum();
  expect(document.querySelector('.weq-label-album')).toBeNull();
  await click('合成相册');
  state.target = '10004';
  await renderAlbum();
  expect(document.querySelector('.weq-label-album')).toBeNull();
});
it('后续页失败保留已加载签名，重试不清空正文', async () => {
  state.signatures.mockReturnValue({
    ...result({ pages: [page] }),
    hasNextPage: true,
    error: new Error('合成后页失败'),
  });
  await render('signature');
  await click('历史签名');
  expect(document.body.textContent).toContain('合成历史签名');
  await click('重试本页');
  expect(state.next).toHaveBeenCalledTimes(1);
});
it('重复游标可单独重读末页，不自动连续翻页', async () => {
  const refetch = vi.fn();
  state.signatures.mockReturnValue({
    ...result({ pages: [page, { ...page, items: [{ ...page.items[0], id: 's2' }] }] }),
    refetch,
  });
  await render('signature');
  await click('历史签名');
  await click('重试本页');
  expect(state.next).not.toHaveBeenCalled();
  const select = refetch.mock.calls[0]?.[0].refetchPage;
  expect(select({}, 0, [{}, {}])).toBe(false);
  expect(select({}, 1, [{}, {}])).toBe(true);
});
const education = {
  index: 1,
  category: 3,
  schoolId: 'school',
  schoolName: '合成大学',
  departmentId: 'department',
  departmentName: '合成院系',
  degree: 6,
  enrollmentYear: 2019,
  graduationYear: 2023,
  allowRecommend: 0,
  createSource: null,
  createdAt: null,
  updateSource: null,
  updatedAt: null,
  hidden: 0,
  verifyStatus: 2,
  verifyType: 1,
};
it('教育经历打开后才查询，展示全部同校记录和院系学历年份，不伪造分页', async () => {
  state.education.mockReturnValue(
    result({ targetUin: '10002', items: [education, { ...education, index: 2, degree: 7 }] }),
  );
  await render();
  expect(state.education).not.toHaveBeenCalled();
  await click('教育经历');
  expect(state.education.mock.calls.at(-1)?.[0]).toMatchObject({
    uin: '10002',
    expectedAccountUin: '10001',
  });
  expect(document.querySelectorAll('.weq-education-record')).toHaveLength(2);
  expect(document.body.textContent).toContain('合成院系');
  expect(document.body.textContent).toContain('本科');
  expect(document.body.textContent).toContain('研究生');
  expect(document.body.textContent).toContain('2019 年入学 · 2023 年毕业');
  expect(document.body.textContent).toContain('已认证');
  expect(document.body.textContent).not.toContain('加载更多');
});
it('他人隐藏经历不展示，自己的经历保留并标明未公开', async () => {
  state.education.mockImplementation((input) =>
    result({ targetUin: input.uin, items: [{ ...education, hidden: 1 }] }),
  );
  await render();
  await click('教育经历');
  expect(document.querySelectorAll('.weq-education-record')).toHaveLength(0);
  state.target = state.account;
  await render();
  await click('教育经历');
  expect(document.body.textContent).toContain('合成大学');
  expect(document.body.textContent).toContain('未公开');
});
it('教育刷新失败保留已读内容，可重试且不展示其他目标的缓存', async () => {
  const refetch = vi.fn();
  state.education.mockReturnValue({
    ...result({ targetUin: '10002', items: [education] }),
    error: new Error('暂不可读'),
    refetch,
  });
  await render();
  await click('教育经历');
  expect(document.body.textContent).toContain('合成大学');
  expect(document.body.textContent).toContain('已显示的教育经历保留');
  await click('重试');
  expect(refetch).toHaveBeenCalledOnce();
  state.education.mockReturnValue(result({ targetUin: '10003', items: [education] }));
  await render();
  expect(document.body.textContent).not.toContain('合成大学');
  expect(document.body.textContent).toContain('读取失败');
});
it('教育经历离线不发查询，缺失与未知学历不冒充零年份', async () => {
  state.online = false;
  state.education.mockReturnValue(result());
  await render();
  await click('教育经历');
  expect(state.education.mock.calls.at(-1)?.[1].enabled).toBe(false);
  expect(document.body.textContent).toContain('暂不可在线读取');
  state.online = true;
  state.education.mockReturnValue(
    result({
      targetUin: '10002',
      items: [
        { ...education, schoolName: null, degree: 77, enrollmentYear: 0, graduationYear: null },
      ],
    }),
  );
  await render();
  expect(document.body.textContent).toContain('未填写学校');
  expect(document.body.textContent).toContain('学历编号 77');
  expect(document.body.textContent).not.toContain('0 年入学');
});
