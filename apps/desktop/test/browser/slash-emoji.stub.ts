import { preferenceDefaults, type PreferencePatch } from '@weq/service/client-preferences';

let revision = 0;
const preferences = { ...preferenceDefaults };
export function patchPreferences(values: PreferencePatch) {
  Object.assign(preferences, values);
  return { revision: ++revision, values: { ...preferences }, records: {} };
}

const catalog = {
  faces: [
    { id: '14', desc: '[微笑]', shortcuts: ['wx', ':)'] },
    { id: '297', desc: '/拜谢', shortcuts: ['bx'] },
    { id: '319', desc: '/比心', shortcuts: [] },
    { id: '182', desc: '/笑哭', shortcuts: ['xk'] },
    { id: '76', desc: '/赞', shortcuts: ['qiang', 'strong'] },
    { id: '75', desc: '/弱', shortcuts: ['ruo', 'weak'] },
    ...Array.from({ length: 10 }, (_, index) => ({
      id: String(20 + index),
      desc: `合成表情${index}`,
    })),
  ],
  recent: [
    { id: '14', usedAt: 10 },
    { id: '76', usedAt: 30 },
    { id: '182', usedAt: 20 },
  ],
};
const account = { uin: '26113', configId: 'fixture' };
const proxy = (path = ''): unknown =>
  new Proxy(() => proxy(path), {
    get: (_target, key) =>
      key === 'useQuery'
        ? () => ({
            data: path.endsWith('shortcuts')
              ? catalog
              : path.endsWith('getAccountConfig')
                ? account
                : undefined,
            isLoading: false,
            isFetching: false,
          })
        : key === 'mutate' && path.endsWith('clientState.patch')
          ? async (values: PreferencePatch) => patchPreferences(values)
          : key === 'useMutation'
            ? () => ({ mutate() {}, mutateAsync: async () => undefined, isLoading: false })
            : ['query', 'fetch', 'invalidate'].includes(String(key))
              ? async () => undefined
              : proxy(`${path}.${String(key)}`),
  });
export const trpc = proxy();
export const client = proxy();
