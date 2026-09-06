/**
 * 报告里「我自己」的那张脸 —— 头像 + 头像挂件。
 *
 * 装扮页的主体要把当年那套装扮**穿在自己身上**（头像 + 挂件 + 气泡同框），所以这里
 * 把两个来源拼成一个值：
 *  - 头像：`account.getSelfProfile` 的 uin → CDN url → `cachedAvatarUrl` 转成本地优先
 *    的 `weq-media://avatar`（QQ 自己缓存过的那份，离线也画得出来）；
 *  - 挂件：`SelfPendantContext`（bootstrap 时存下的 homeDress.widgetUrl，无网络）。
 *
 * 两者都可能缺席：头像取不到画首字兜底，挂件取不到就只画头像 —— 用户明确要求
 * 「无论有没有挂件都把头像加上」。全程静默，年度报告不为资源缺失弹任何提示。
 */

import { trpc } from '../../trpc/client';
import { useSelfPendant } from '../../hooks/useSelfPendant';
import { avatarFromUin } from '../../lib/avatarResolver';
import { cachedAvatarUrl } from '../../lib/avatarCache';

export type SelfFace = {
  /** 头像 url，取不到为空串（画 {@link SelfFace.initial} 兜底）。 */
  avatarUrl: string;
  /** 自己的挂件图 url，没装挂件为空串。 */
  pendantUrl: string;
  /** 昵称首字，头像画不出来时顶上。 */
  initial: string;
  nick: string;
};

export function useSelfFace(): SelfFace {
  const profile = trpc.account.getSelfProfile.useQuery(undefined, { staleTime: 5 * 60_000 });
  const pendantUrl = useSelfPendant();

  const nick = profile.data?.nick ?? '';
  // uin 派生的那条是稳定的；wire 里的 avatarUrl 常常是只有活 QQ 才补得全的
  // 聊天 CDN token（见 main/ipc/serde.ts 的注释），所以只当兜底。
  const avatarUrl =
    cachedAvatarUrl(avatarFromUin(profile.data?.uin) || profile.data?.avatarUrl) ?? '';

  return {
    avatarUrl,
    pendantUrl,
    initial: nick.slice(0, 1) || '我',
    nick,
  };
}
