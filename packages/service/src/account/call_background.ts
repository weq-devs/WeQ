/**
 * 通话背景（个性装扮里 appId 17「来电」）的取用策略。
 *
 * 通话窗口要一张底图。它来自 `zb.vip.qq.com` 的装扮接口，取它需要 `vip.qq.com`
 * 的 p_skey —— 而 p_skey 要么现向在线实例要（要读内存 / 走 hook），要么用登录时
 * 收下的那份（时效很短）。**通话是实时交互，不该为了背景图去等一次网络往返**。
 *
 * 所以这里定一条「能省就省、不能省才查」的规则：
 *
 *   1. 账号配置里的装扮快照已经有 `callBgUrl` / `callBgVideoUrl` → 直接用，不联网；
 *   2. 快照里**查过**这一项（`callBgCheckedAt` 有值）但 URL 是空的 → 用户确实没设
 *      通话背景，也不联网；
 *   3. 其余情况（老快照，这一项从没查过）→ 查一次，结果写回快照。
 *
 * 第 2 条是「跳过」的关键：光看 URL 是否为空分不清「没设」和「没查过」，会
 * 每次通话都白查一遍。`callBgCheckedAt` 就是这个判据。
 *
 * 查失败**不影响通话**：背景是装饰，通话能不能打通不取决于它。失败只记日志。
 */

import type { AccountSession } from '@weq/account';
import type { AccountConfigService } from './user_config';
import { fetchHomeDress } from './home_dress';
import { getLogger, logErrorContext } from '../common/logger';
import type { WebNative } from './web/credential';

const logger = getLogger().child({ scope: 'call-background' });

export interface CallBackground {
  /** 静态图（视频的首帧 / 视频不可用时的兜底）。 */
  imageUrl: string;
  /** 动态背景。非空时优先播它。 */
  videoUrl: string;
  itemId: number;
  name: string;
}

const EMPTY: CallBackground = { imageUrl: '', videoUrl: '', itemId: 0, name: '' };

/**
 * 确保拿到当前账号的通话背景。
 *
 * @param config 账号配置服务（快照的读写口）。
 * @param refresh 显式要求重新查一次（装扮页改完之后用）。
 */
export async function ensureCallBackground(
  nt: WebNative,
  session: AccountSession,
  config: AccountConfigService,
  pid: number,
  options: { refresh?: boolean } = {},
): Promise<CallBackground> {
  const cached = config.getRecord()?.homeDress;

  // 1 / 2：已经查过这一项就不联网。
  if (!options.refresh && cached?.callBgCheckedAt) {
    return {
      imageUrl: cached.callBgUrl ?? '',
      videoUrl: cached.callBgVideoUrl ?? '',
      itemId: cached.callBgId ?? 0,
      name: cached.callBgName ?? '',
    };
  }

  try {
    // 只为了背景而拉整份快照有点浪费，但 `GetNewStyleAppUsing` 是一次请求返回
    // 所有类目，拆不出更小的调用 —— 顺便把其它项也刷新了，没有额外成本。
    const snapshot = await fetchHomeDress(
      nt,
      session,
      pid,
      config.getRecord()?.loginPskey,
      (domain) => config.clearLoginPskey(domain),
    );
    // `fetchHomeDress` 已经写好了 `callBgCheckedAt`（查过就是查过，哪怕没设）。
    config.setHomeDress(snapshot);
    logger.info('resolved call background', {
      event: 'call-background-resolved',
      hasImage: Boolean(snapshot.callBgUrl),
      hasVideo: Boolean(snapshot.callBgVideoUrl),
      itemId: snapshot.callBgId ?? 0,
    });
    return {
      imageUrl: snapshot.callBgUrl ?? '',
      videoUrl: snapshot.callBgVideoUrl ?? '',
      itemId: snapshot.callBgId ?? 0,
      name: snapshot.callBgName ?? '',
    };
  } catch (error) {
    // 卖点：失败不抛出。宁可这通电话用默认底图，也不要因为装饰资源打不开而拨不出去。
    logger.warn('failed to resolve call background; falling back to default', {
      event: 'call-background-failed',
      ...logErrorContext(error),
    });
    return EMPTY;
  }
}
