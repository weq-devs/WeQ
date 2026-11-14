import { formatQqRegion } from '@weq/protocol/profile-regions';
import { QQ_PROFESSIONS } from '@weq/protocol/profile-values';
import * as base from './contact-card.stub';
export { useQQWriteSession } from './contact-card.stub';

export const summaryQa = {
  state: 'ready' as 'ready' | 'empty' | 'error' | 'loading',
  calls: [] as string[],
};
const regions = [
  {
    code: '1',
    name: '中国',
    children: [
      {
        code: '35',
        name: '福建',
        children: [
          { code: '2', name: '厦门', children: [{ code: '0', name: '不限', children: [] }] },
        ],
      },
    ],
  },
];
Object.assign(window, { profileApprovedQa: summaryQa });
function value(path: string, input: { uin?: string }) {
  const targetUin = input?.uin ?? base.qa.account;
  if (path === 'account.profileExtras.medalWall')
    return {
      targetUin,
      count: summaryQa.state === 'empty' ? 0 : 12,
      openFlag: 0,
      newCount: 1,
      upgradeCount: 2,
      detailsUrl: `https://ti.qq.com/qqmedal2/index.html?tuin=${targetUin}`,
    };
  if (path === 'account.profileExtras.similarity')
    return {
      targetUin,
      items:
        summaryQa.state === 'empty'
          ? []
          : [
              {
                title: '同校',
                icon: null,
                wordings: ['合成学校', '较长的共同点文案，用于验证窄屏换行和内容列的布局。'],
              },
              {
                title: '共同兴趣',
                icon: null,
                wordings: ['这是 QQ 返回的合成资料，不是 AI 推断。'],
              },
            ],
    };
  if (path === 'account.qqWrite.profileRegions') return { regions, professions: QQ_PROFESSIONS };
  if (path === 'account.qqWrite.editableSelfProfile')
    return {
      hometown: ['1', '35', '2', '0'],
      region: ['1', '35', '2'],
      birthday: '2000-02-29',
      email: 'self@example.invalid',
      profession: 0,
      company: '合成公司',
      personalDescription: '合成说明',
      school: '合成学校',
      errors: {},
    };
  return undefined;
}
function wrap(source: unknown, path = ''): unknown {
  return new Proxy(() => {}, {
    get(_target, key) {
      if (key === 'useQuery')
        return (input: { uin?: string }, options?: { enabled?: boolean }) => {
          base.useFixture();
          const current = value(path, input);
          if (current === undefined) {
            const query = Reflect.get(source as object, key) as (
              input: unknown,
              options: unknown,
            ) => { data?: object };
            const result = query(input, options);
            return path === 'account.profileExtras.details' && result.data
              ? {
                  ...result,
                  data: {
                    ...result.data,
                    hometown: ['1', '35', '2', '0'],
                    hometownText: formatQqRegion(['1', '35', '2', '0'], regions),
                  },
                }
              : result;
          }
          if (options?.enabled !== false) summaryQa.calls.push(path);
          const special = path.startsWith('account.profileExtras.');
          return {
            data:
              options?.enabled === false || (special && summaryQa.state === 'loading')
                ? undefined
                : current,
            error: special && summaryQa.state === 'error' ? new Error('合成读取失败') : null,
            isFetching: special && summaryQa.state === 'loading',
            isLoading: special && summaryQa.state === 'loading',
            isSuccess: true,
            refetch: async () => {
              summaryQa.state = 'ready';
              base.qa.notify();
              return { data: current };
            },
          };
        };
      const child = Reflect.get(source as object, key);
      if (
        key === 'query' ||
        key === 'mutate' ||
        key === 'useMutation' ||
        key === 'useUtils' ||
        key === 'useContext'
      )
        return child;
      return wrap(child, path ? `${path}.${String(key)}` : String(key));
    },
  });
}
// Test-only adapter keeps the incumbent fixture's unrelated routes unchanged.
export const trpc = wrap(base.trpc) as typeof base.trpc;
export const client = base.client;
