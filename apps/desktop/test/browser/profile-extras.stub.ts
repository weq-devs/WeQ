import { useSyncExternalStore } from 'react';

export const client = new Proxy(
  {},
  {
    get() {
      throw new Error('只读资料夹具不允许额外 RPC 调用');
    },
  },
);

type Mode = 'ready' | 'loading' | 'empty' | 'error';
let mode: Mode =
  new URLSearchParams(location.search).get('mode') === 'loading' ? 'loading' : 'ready';
let account = '10001';
let revision = 0;
let signaturePage = 1;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const changed = () => {
  revision++;
  for (const listener of listeners) listener();
};
export const qa = {
  mode(value: Mode) {
    mode = value;
    signaturePage = 1;
    changed();
  },
  account(value: string) {
    account = value;
    changed();
  },
};
export function useQQWriteSession() {
  useSyncExternalStore(subscribe, () => revision);
  return {
    available: true,
    binding: { expectedAccountUin: account, expectedAccountConfigId: 'fixture' },
  };
}
const photo = (index: number) => ({
  id: `photo-${index}`,
  url: `https://p.qpic.cn/profile-extras-fixture-${index}`,
  uploadedAt: 1700000000,
  likes: '2',
});
const label = {
  id: '12',
  text: '合成标签相册',
  cover: photo(0).url,
  photoCount: 2,
  photos: [photo(0)],
  photoCursor: 'AAAABQ==',
};
const signature = {
  id: 'signature-1',
  text: '保持原始签名文本。这里是一条较长的合成历史签名，用于核对手机上的换行与时间布局。',
  action: null,
  data: null,
  location: '合成地点',
  createdAt: 1700000000,
};
const education = {
  index: 1,
  category: 3,
  schoolId: 'fixture-school',
  schoolName: '合成大学与较长学校名称用于窄屏换行验证',
  departmentId: 'fixture-department',
  departmentName: '合成院系与专业方向',
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
const page = (items: unknown[], nextCursor: string | number | null = null) => ({
  targetUin: '10001',
  items,
  nextCursor,
  hasMore: nextCursor !== null,
  paginationError: null,
});
function useQuery(kind: string, input: { uin: string }) {
  useSyncExternalStore(subscribe, () => revision);
  const pending = mode === 'loading';
  const error = mode === 'error' ? new Error('合成错误') : null;
  const empty = mode === 'empty';
  const value =
    kind === 'details'
      ? {
          targetUin: input.uin,
          company: empty ? '' : '合成公司与较长公司名称用于窄屏换行验证',
          personalDescription: empty
            ? null
            : '第一行个人说明。\n第二行说明用于验证原始换行。' +
              'LongDescriptionWithoutSpaces'.repeat(8),
          email: empty ? '' : 'synthetic-long-address@example.invalid',
          errors: {},
        }
      : kind === 'energy'
        ? { targetUin: input.uin, score: 831, level: 1 }
        : kind === 'education'
          ? {
              targetUin: input.uin,
              items: empty ? [] : [education, { ...education, index: 2, degree: 7, hidden: 1 }],
            }
          : { targetUin: input.uin, labels: empty ? [] : [label], totalPhotos: 2, closed: false };
  return {
    data: pending || error ? undefined : value,
    isFetching: pending,
    error,
    refetch: async () => {
      qa.mode('ready');
    },
  };
}
function useInfiniteQuery(kind: string) {
  useSyncExternalStore(subscribe, () => revision);
  const pending = mode === 'loading';
  const error = mode === 'error' ? new Error('合成错误') : null;
  const empty = mode === 'empty';
  const values =
    kind === 'signatureHistory'
      ? [
          page(empty ? [] : [signature], 1699999999),
          ...(signaturePage > 1
            ? [page([{ ...signature, id: 'signature-2', text: '第二页签名' }])]
            : []),
        ]
      : kind === 'personalityPhotos'
        ? [page(empty ? [] : [photo(1)])]
        : [
            page(
              empty
                ? []
                : [
                    {
                      id: 'q1',
                      question: '这是完整的合成问题吗？',
                      answer:
                        '这是一条合成回答。长内容在 320px 视口中也应当正确换行，不覆盖时间和互动数量。',
                      askedAt: 1700000000,
                      answeredAt: 1700000010,
                      likes: '3',
                      comments: '1',
                    },
                  ],
            ),
          ];
  return {
    data: pending || error ? undefined : { pages: values },
    isFetching: pending,
    error,
    hasNextPage: kind === 'signatureHistory' && signaturePage === 1 && !empty,
    refetch: async () => {
      qa.mode('ready');
    },
    fetchNextPage: async () => {
      signaturePage++;
      changed();
    },
  };
}
export const trpc = {
  account: {
    profileExtras: {
      details: { useQuery: (input: { uin: string }) => useQuery('details', input) },
      energy: { useQuery: (input: { uin: string }) => useQuery('energy', input) },
      educationHistory: { useQuery: (input: { uin: string }) => useQuery('education', input) },
      personalityLabels: { useQuery: (input: { uin: string }) => useQuery('labels', input) },
      signatureHistory: { useInfiniteQuery: () => useInfiniteQuery('signatureHistory') },
      personalityPhotos: { useInfiniteQuery: () => useInfiniteQuery('personalityPhotos') },
      anonymousQuestions: { useInfiniteQuery: () => useInfiniteQuery('questions') },
    },
  },
};
