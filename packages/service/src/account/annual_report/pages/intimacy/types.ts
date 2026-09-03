import type { IntimacyFriend } from '../../types';

/**
 * Data contract for the 好友亲密度 page — the friends who reached the QQ
 * intimacy threshold this report shows.
 *
 * Type-only import target for the renderer page component (`@weq/service`),
 * so a field rename here fails the renderer typecheck instead of crashing at
 * runtime.
 */
export type IntimacyPageData = {
  /** 亲密度门槛，只有达到该分数的好友才会出现在报告里。 */
  minScore: number;
  /** 达标好友数（≤ listLimit，用于文案的“共 N 位”）。 */
  total: number;
  /** 达标好友，按亲密度高→低。 */
  friends: IntimacyFriend[];
};
