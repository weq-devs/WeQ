/**
 * 好感度胶囊 —— 私聊会话头部右上角常驻（chat-actions 首位）。
 *
 * 数据走 intentSense.getProfile（与画像 Dialog 同源），档位变化时图标与配色
 * 一起切换并重放 bump 动画（key=tier 触发 remount）。点击就地打开画像 Dialog
 * （OverlayLayer 会 portal 到 body，挂在 header 里不影响布局，也不用把开关
 * 一路透传到 MainView）。群聊 / 功能未开启时由挂载方（chatPane）负责不渲染。
 */

import { useEffect, useRef, useState } from 'react';
import { Heart, Sparkles, Star, Zap, Flame } from 'lucide-react';
import { trpc } from '../../trpc/client';
import { useIntentSenseStatus } from './context';
import { IntentProfileDialog } from './IntentProfileDialog';
import '../../styles/intent-sense.css';

const TIERS = [
  { icon: Heart, label: '初识' },
  { icon: Zap, label: '熟络' },
  { icon: Sparkles, label: '亲近' },
  { icon: Star, label: '挚友' },
  { icon: Flame, label: '羁绊' },
] as const;

export function AffinityPill({
  peerUid,
  peerName,
}: {
  peerUid: string;
  /** 画像 Dialog 标题里显示的名字（缺省回落到「TA」）。 */
  peerName?: string;
}) {
  const status = useIntentSenseStatus();
  const statusData = status.data;
  const overridden = statusData?.conversationOverrides?.[`c2c:${peerUid}`];
  const engineOk =
    statusData?.engine === 'local' ? !!statusData.localReady : !!statusData?.apiConfigured;
  const active = !!statusData?.enabled && overridden !== false && engineOk;
  const profile = trpc.account.intentSense.getProfile.useQuery(
    { peerUid },
    { enabled: active, refetchOnWindowFocus: false, staleTime: 60_000, retry: false },
  );
  const [bumped, setBumped] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const prevTier = useRef<number | null>(null);

  const tier = Math.max(0, Math.min(4, profile.data?.tier ?? 0));
  const meta = TIERS[tier]!;
  const Icon = meta.icon;

  useEffect(() => {
    if (prevTier.current !== null && prevTier.current !== tier) {
      setBumped(true);
      const t = setTimeout(() => setBumped(false), 450);
      return () => clearTimeout(t);
    }
    prevTier.current = tier;
  }, [tier]);

  if (!active) return null;

  const dialog = profileOpen ? (
    <IntentProfileDialog
      peerUid={peerUid}
      peerName={peerName?.trim() || 'TA'}
      onClose={() => setProfileOpen(false)}
    />
  ) : null;

  if (profile.isLoading || !profile.data) {
    // 加载中：低调的灰胶囊占位，避免 header 宽度跳动。
    return (
      <button
        type="button"
        className="weq-affinity-pill tier-0 weq-int-pill-loading"
        title="意图感知"
        aria-label="意图感知加载中"
      >
        <Heart size={13} />
        <span>…</span>
      </button>
    );
  }

  return (
    <>
      <button
        type="button"
        key={tier}
        className={`weq-affinity-pill tier-${tier}${bumped ? ' is-bumped' : ''}`}
        title={`好感度 ${profile.data.affinity} · ${meta.label}（仅供娱乐参考）`}
        aria-label={`对方互动画像：好感度 ${profile.data.affinity}`}
        onClick={() => setProfileOpen(true)}
      >
        <Icon size={13} strokeWidth={2.2} />
        <span>
          {meta.label} {profile.data.affinity}
        </span>
      </button>
      {dialog}
    </>
  );
}
