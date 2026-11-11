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
        signatureHistory: { useInfiniteQuery: state.signatures },
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
