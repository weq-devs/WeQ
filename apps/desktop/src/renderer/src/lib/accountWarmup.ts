/**
 * 进入账号前的数据预热。
 *
 * MainView 一挂载就并发打 8 个查询（见 MainView.tsx 顶部），其中 4 个 limit:2000。
 * 在它们落地之前，首页只能拿兜底值渲染——空白头像 + 默认昵称 "WeQ"。更糟的是
 * MainView 的第一帧发生在窗口 resize（home 1120×580 → chat 1180×760）之前，左栏
 * 按上下贴边排的按钮塞不进 580 高度，会上下重叠。
 *
 * 所以把这批查询提到还在 splash 的时候跑完：预热写进的是 React Query 的同一份
 * 缓存（`utils.X.fetch` 与 `trpc.X.useQuery` 同 key），且 provider 里 staleTime
 * 5 分钟 + refetchOnMount:false，因此 MainView 挂载时这 8 个 useQuery 全部命中缓存
 * 同步返回，第一帧即完整。
 *
 * 并发跑而非串行——串行会把总耗时变成各步之和，比现在还慢。这里要的是「同样的
 * 墙钟时间，但等齐了再进」，不是更快。
 */

import type { trpc } from '../trpc/client';

type Utils = ReturnType<typeof trpc.useUtils>;

/** 预热到一半就放行的上限。见 {@link runAccountWarmup} 的说明。 */
const WARMUP_TIMEOUT_MS = 10_000;

interface WarmupStep {
  /** 进度条下方的说明文字。 */
  readonly label: string;
  readonly run: (utils: Utils) => Promise<unknown>;
}

/**
 * 与 MainView 顶部那批 useQuery 一一对应——**入参必须逐字一致**，否则 query key
 * 对不上，预热的结果 MainView 读不到，等于白等一轮。
 */
const STEPS: readonly WarmupStep[] = [
  { label: '账号资料', run: (u) => u.account.getSelfProfile.fetch(undefined) },
  { label: '最近会话', run: (u) => u.account.listRecentContacts.fetch(undefined) },
  { label: '好友列表', run: (u) => u.account.listBuddies.fetch({ limit: 2000 }) },
  { label: '好友分组', run: (u) => u.account.listCategories.fetch(undefined) },
  { label: '好友资料', run: (u) => u.account.listProfiles.fetch({ limit: 2000 }) },
  { label: '好友申请', run: (u) => u.account.listBuddyRequests.fetch({ limit: 2000 }) },
  { label: '群通知', run: (u) => u.account.listGroupNotifies.fetch({ limit: 2000 }) },
  { label: '群列表', run: (u) => u.account.listAllGroups.fetch({ limit: 2000 }) },
];

export interface WarmupProgress {
  /** 已完成步数（含失败——失败也不该把用户永远挡在门外）。 */
  done: number;
  total: number;
  /** 尚未完成的第一步，用于「正在载入 X…」。全部完成时为 null。 */
  pending: string | null;
}

export const WARMUP_TOTAL = STEPS.length;

/**
 * 跑完全部预热，或到点放行。
 *
 * **绝不无限等**：任何一步卡住都会把用户永久锁在 splash 上，那比现在的粗糙首页
 * 糟糕得多。超时后直接返回，未落地的查询继续在后台跑，MainView 挂载后由对应的
 * useQuery 接管（退化成当前行为，而不是卡死）。
 *
 * 单步失败同样只记完成、不抛：一个查询挂了不该连累进入账号。
 */
export async function runAccountWarmup(
  utils: Utils,
  onProgress: (progress: WarmupProgress) => void,
  timeoutMs: number = WARMUP_TIMEOUT_MS,
): Promise<void> {
  const remaining = new Set(STEPS.map((s) => s.label));
  let done = 0;

  const emit = (): void => {
    onProgress({
      done,
      total: STEPS.length,
      pending: STEPS.find((s) => remaining.has(s.label))?.label ?? null,
    });
  };
  emit();

  const all = Promise.all(
    STEPS.map((step) =>
      step
        .run(utils)
        .catch(() => null)
        .finally(() => {
          done += 1;
          remaining.delete(step.label);
          emit();
        }),
    ),
  );

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });

  try {
    await Promise.race([all, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
