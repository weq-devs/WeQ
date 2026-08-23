/**
 * `account.mutualMark.*` —— 好友/群友互动标识（任务 / 惊喜 / 限定 / 幸运字符）。
 *
 * 数据来自 ti.qq.com 的互动标识聚合页（`getFriendMutualMark`），要该账号的
 * QQ 票据（skey / p_skey @ ti.qq.com），因此必须在线实例发包。与 peerHome
 * 一样不预先按 qqOnline 短路 —— 一律先打一次，让服务端告诉我们行不行；
 * 失败统一转成「需要在线实例」的提示，底层票据错误不透给前端。
 */
import { z } from 'zod';
import {
  getAppContext,
  requireInjectEnabled,
  type AccountServices,
} from '../../context/app_context';
import { procedure, router } from '../trpc';

function requireServices(): AccountServices {
  const ctx = getAppContext();
  if (!ctx.services) {
    throw new Error('No account session open — call bootstrap.openAccount first.');
  }
  return ctx.services;
}

const MUTUAL_MARK_HINT =
  '获取失败 —— 互动标识要拿该账号的 QQ 票据去查，请确认这个账号的 QQ 客户端正在运行。';

export const mutualMarkRouter = router({
  /** 查 `uin` 与你之间的互动标识（任务 / 惊喜 / 限定 / 幸运字符）。 */
  get: procedure.input(z.object({ uin: z.string().regex(/^\d{5,}$/) })).query(async ({ input }) => {
    requireInjectEnabled();
    const services = requireServices();
    try {
      return await services.webQuery.getFriendMutualMark(input.uin);
    } catch {
      throw new Error(MUTUAL_MARK_HINT);
    }
  }),
});
