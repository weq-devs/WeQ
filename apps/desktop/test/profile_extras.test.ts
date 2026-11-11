import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ProfileExtras } from '../src/renderer/src/components/ProfileExtras';

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
vi.mock('../src/renderer/src/components/QzoneMediaPreview', () => ({
  QzoneMediaPreview: () => h('div', { role: 'dialog', 'aria-label': '标签照片预览' }),
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
it('签名入口按需打开详情，保留时间地点并支持翻页', async () => {
  await render('signature');
  await click('历史签名');
  expect(document.body.textContent).toContain('合成历史签名');
  expect(document.body.textContent).toContain('合成位置');
  await click('加载更多');
  expect(state.next).toHaveBeenCalledTimes(1);
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
it('能量值失败不阻塞标签入口', async () => {
  state.energy.mockReturnValue({ ...result(), error: new Error('暂不可用') });
  await render();
  expect(host.textContent).toContain('暂不可读取');
  await click('标签相册');
  expect(state.labels).toHaveBeenCalled();
  expect(document.body.textContent).toContain('暂无标签相册');
});
it('已结束的照片首批直接展示，点击复用预览', async () => {
  state.labels.mockReturnValue(
    result({
      targetUin: '10002',
      labels: [
        {
          id: 'label',
          text: '合成相册',
          cover: null,
          photoCount: 1,
          photoCursor: null,
          photos: [{ id: 'p', url: 'https://p.qpic.cn/fixture', uploadedAt: null, likes: null }],
        },
      ],
    }),
  );
  await render();
  await click('标签相册');
  await click('合成相册');
  expect(state.photos.mock.calls.at(-1)?.[1].enabled).toBe(false);
  const photo = document.querySelector<HTMLButtonElement>('[aria-label="查看第 1 张照片"]');
  await act(async () => photo!.click());
  expect(document.querySelector('[aria-label="标签照片预览"]')).toBeTruthy();
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
  expect(document.querySelectorAll('.weq-education-list article')).toHaveLength(2);
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
  expect(document.querySelectorAll('.weq-education-list article')).toHaveLength(0);
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
  await click('刷新');
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
