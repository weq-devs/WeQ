/**
 * 顶栏昵称后的会员徽标（VIP / SVIP / 大会员）。
 *
 * 数据来自 `account.getSelfVip`：在线时是 club.vip 接口的权威快照，离线时退回
 * 落盘缓存或本地 21000 特权清单。徽标是纯文字胶囊 —— 历史素材
 * `resources/svip/*.png` 是固定金底红字位图，既盖不住「三档三色」的语义，
 * 也不会跟随深浅模式，所以这里用 CSS。
 *
 * 刷新时机由主进程的 `VipBadgeService` 决定（登录 seed 票据、QQ 上线、
 * 低频校正），这里只订阅 `onVipChanged` 做一次 invalidate。
 */

import { trpc } from '../trpc/client';
import { useViewState } from '../state/view';

type VipTier = 'vip' | 'svip' | 'bvip';

const TIER_TEXT: Record<VipTier, string> = {
  vip: 'VIP',
  svip: 'SVIP',
  bvip: '大会员',
};

const TIER_NAME: Record<VipTier, string> = {
  vip: 'QQ 会员',
  svip: '超级会员',
  bvip: '大会员',
};

/** `YYYY-MM-DD`（按用户本地时区）。 */
function expireText(seconds: number | undefined): string | null {
  if (!seconds) return null;
  const at = new Date(seconds * 1000);
  if (Number.isNaN(at.getTime())) return null;
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(
    at.getDate(),
  ).padStart(2, '0')}`;
}

export function VipBadge({ className }: { className?: string }) {
  const openedUin = useViewState((s) => s.openedUin);
  const utils = trpc.useUtils();
  const { data } = trpc.account.getSelfVip.useQuery(undefined, { refetchOnMount: 'always' });

  // 后台刷新完成 → 重新读一次。订阅本身会补发一次，所以晚于首屏挂载的写入也能收到。
  trpc.account.onVipChanged.useSubscription(undefined, {
    onData: () => {
      void utils.account.getSelfVip.invalidate();
    },
  });

  // 切号瞬间 react-query 可能还拿着上一个账号的快照：uin 对不上就先不渲染。
  const stale = Boolean(data?.uin && openedUin && data.uin !== openedUin);
  if (!data || stale) return null;

  const tier = data.tier;
  const label = `${data.year ? '年 ' : ''}${TIER_TEXT[tier]}`;
  const detail = [
    TIER_NAME[tier] + (data.year ? '（年费）' : ''),
    data.source === 'local' ? '来自本地资料库' : null,
    data.source === 'club-api' && data.level > 0 ? `${data.level} 级` : null,
    expireText(data.expireAt) ? `到期 ${expireText(data.expireAt)}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <span
      className={`app-title-bar-vip-badge is-${tier}${className ? ` ${className}` : ''}`}
      title={detail}
    >
      {label}
    </span>
  );
}
