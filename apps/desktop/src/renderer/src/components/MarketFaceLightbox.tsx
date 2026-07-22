/**
 * 商城表情「一组表情」灯箱 —— 点击聊天里的商城表情，弹出它所在整包的全部表情。
 *
 *   - openMarketFaceLightbox(packId, activeHash?)  命令式打开；重复打开同一个
 *     packId 是 no-op（内建去重），activeHash 用于在网格里高亮「刚点的那张」。
 *   - <MarketFaceLightbox/>                        挂载一次（近根部）；渲染当前
 *     store 指向的整包表情网格（单一全局 portal）。
 *
 * 「一组表情」的数据来源与本地资源页「商城表情包」完全同构：走
 * `account.marketEmoji.getPackDetail({ packId })` 在线补全整包表情列表，图片指向
 * `weq-media://mface?...&enc=tea`（密钥后端自动恢复），不过 tRPC 传字节。
 *
 * 视觉与 {@link ImageLightbox} 同骨架（.weq-lightbox-layer/-stage/-close），
 * 内容换成表情包信息条 + 表情网格。点击背景或 ESC 关闭。
 */

import { useEffect, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { X, Store, RefreshCw } from 'lucide-react';
import type { MarketPackFeeType } from '@weq/service';
import { trpc } from '@renderer/trpc/client';
import { mediaUrl } from '@renderer/lib/resourceUrl';

/** 来源徽章元信息（与 MarketPackExplorer 保持一致）。 */
const FEE_META: Record<MarketPackFeeType, { label: string; tone: string }> = {
  free: { label: '免费', tone: 'free' },
  paid: { label: '付费', tone: 'paid' },
  svip: { label: 'SVIP', tone: 'svip' },
  vip: { label: 'VIP', tone: 'vip' },
  unknown: { label: '未知', tone: 'unknown' },
};

/** weq-media URL：商城表情包的一张表情（TEA 解密路径，密钥后端自动恢复）。 */
function packImageUrl(packId: string, hash: string): string {
  return mediaUrl('mface', { pack: packId, hash, enc: 'tea' });
}

interface MarketFaceLightboxStore {
  packId: string | null;
  activeHash: string;
  open(packId: string, activeHash?: string): void;
  close(): void;
}

const useMarketFaceLightbox = create<MarketFaceLightboxStore>((set, get) => ({
  packId: null,
  activeHash: '',
  open(packId, activeHash = '') {
    if (!packId || get().packId === packId) return; // de-dup: same pack already open
    set({ packId, activeHash });
  },
  close() {
    set({ packId: null, activeHash: '' });
  },
}));

/** 打开某个商城表情包的整组灯箱。activeHash 高亮刚点的那张。 */
export function openMarketFaceLightbox(packId: string, activeHash?: string): void {
  useMarketFaceLightbox.getState().open(packId, activeHash);
}

/** 挂载一次。渲染当前商城表情包的整组表情网格（若有）。 */
export function MarketFaceLightbox(): ReactElement | null {
  const packId = useMarketFaceLightbox((s) => s.packId);
  const activeHash = useMarketFaceLightbox((s) => s.activeHash);
  const close = useMarketFaceLightbox((s) => s.close);

  useEffect(() => {
    if (!packId) return;
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') close();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [packId, close]);

  if (typeof document === 'undefined' || !packId) return null;

  return createPortal(
    <div className="weq-lightbox-layer weq-anim-fade" onMouseDown={close}>
      <button className="weq-lightbox-close" type="button" onClick={close} aria-label="关闭">
        <X size={22} />
      </button>
      <div
        className="weq-lightbox-stage weq-anim-pop weq-mface-lightbox"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <MarketFacePackView packId={packId} activeHash={activeHash} />
      </div>
    </div>,
    document.body,
  );
}

/** 灯箱内容：表情包信息条 + 表情网格（高亮 activeHash）。 */
function MarketFacePackView({
  packId,
  activeHash,
}: {
  packId: string;
  activeHash: string;
}): ReactElement {
  const detail = trpc.account.marketEmoji.getPackDetail.useQuery({ packId });
  const fee = FEE_META[detail.data?.feeType ?? 'unknown'];
  const items = detail.data?.items ?? [];

  return (
    <div className="weq-mface-lb-panel">
      <div className="weq-mface-lb-head">
        <Store size={16} className="weq-mface-lb-head-icon" />
        <span className="weq-mface-lb-title">
          {detail.data?.name || `表情包 ${packId}`}
        </span>
        <em className={`weq-mpack-fee is-${fee.tone}`}>{fee.label}</em>
        {detail.data ? (
          <span className="weq-mface-lb-count">{detail.data.count} 张</span>
        ) : null}
      </div>

      {detail.isLoading ? (
        <div className="weq-mface-lb-state">获取这组表情中…</div>
      ) : !detail.data ? (
        <div className="weq-mface-lb-state is-error">
          无法获取这组表情（网络问题或包不存在）
        </div>
      ) : items.length === 0 ? (
        <div className="weq-mface-lb-state">这个表情包暂时没有可显示的表情</div>
      ) : (
        <div className="weq-mface-lb-scroll">
          <div className="weq-mface-lb-grid">
            {items.map((it) => (
              <MarketFaceCell
                key={it.hash}
                packId={packId}
                hash={it.hash}
                name={it.name}
                active={it.hash === activeHash}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** 一张表情：TEA 解密后的 GIF；失败显示占位。当前点击的那张高亮。 */
function MarketFaceCell({
  packId,
  hash,
  name,
  active,
}: {
  packId: string;
  hash: string;
  name: string;
  active: boolean;
}): ReactElement {
  const [broken, setBroken] = useState(false);
  return (
    <figure
      className={`weq-mface-lb-cell${active ? ' is-active' : ''}`}
      title={name || hash}
    >
      <span className="weq-mface-lb-stage">
        {broken ? (
          <RefreshCw size={18} strokeWidth={1.4} className="weq-mface-lb-fallback" />
        ) : (
          <img
            src={packImageUrl(packId, hash)}
            alt={name || hash}
            loading="lazy"
            draggable={false}
            onError={() => setBroken(true)}
          />
        )}
      </span>
      {name ? <figcaption className="weq-mface-lb-name">{name}</figcaption> : null}
    </figure>
  );
}
