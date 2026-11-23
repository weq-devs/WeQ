import { client as baseClient, trpc as baseTrpc } from './trpc.stub';

let finishTranslation: ((text: string) => void) | undefined;
export function resolveTranslation(text: string) {
  finishTranslation?.(text);
  finishTranslation = undefined;
}

function override(target: unknown, fields: Record<string, unknown>) {
  return new Proxy(target as object, {
    get: (base, key) =>
      typeof key === 'string' && Object.hasOwn(fields, key) ? fields[key] : Reflect.get(base, key),
  });
}

function account(root: unknown) {
  return (root as { account: unknown }).account;
}

const motionTrpc = override(baseTrpc, {
  account: override(account(baseTrpc), {
    getAccountConfig: {
      useQuery: () => ({ data: { uin: '26113', configId: 'motion-fixture' } }),
    },
  }),
});

const motionClient = override(baseClient, {
  account: override(account(baseClient), {
    qqActions: override((account(baseClient) as { qqActions: unknown }).qqActions, {
      translateEnglish: {
        mutate: () =>
          new Promise<string>((resolve) => {
            finishTranslation = resolve;
          }),
      },
    }),
  }),
});

const motion = new URLSearchParams(location.search).has('motion');
export const trpc = motion ? motionTrpc : baseTrpc;
export const client = motion ? motionClient : baseClient;
