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
 * 网格里的每张表情都可以再点开**单张详情**（同包内左右切换）：大图 + 名称 + 协议
 * 参数（pack / hash / enc / key）。参数是按当前包实时拼的，key 来自
 * `getPackKey`（拿不到时显示「未恢复」，并说明可手输时间戳）。
 *
 * 视觉与 {@link ImageLightbox} 同骨架（.weq-lightbox-layer/-stage/-close），
 * 内容换成表情包信息条 + 表情网格。点击背景或 ESC 关闭。
 */

import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { ChevronLeft, ChevronRight, Copy, Store, RefreshCw, X } from 'lucide-react';
import type { MarketPackFeeType } from '@weq/service';
import { trpc } from '@renderer/trpc/client';
import { mediaUrl } from '@renderer/lib/resourceUrl';
import { useOverlayLayer } from '@renderer/lib/overlayStack';
import { useToast } from './Toast';
import { MarketImageSave } from './MarketImageSave';

/** 来源徽章元信息（与 MarketPackExplorer 保持一致）。 */
const FEE_META: Record<MarketPackFeeType, { label: string; tone: string }> = {
  free: { label: '免费', tone: 'free' },
  paid: { label: '付费', tone: 'paid' },
  svip: { label: 'SVIP', tone: 'svip' },
  vip: { label: 'VIP', tone: 'vip' },
  unknown: { label: '未知', tone: 'unknown' },
};

/** weq-media URL：商城表情包的一张表情（TEA 解密路径，密钥后端自动恢复）。 */
function packImageUrl(packId: string, hash: string, key?: string): string {
  return mediaUrl('mface', {
    pack: packId,
    hash,
    enc: 'tea',
    ...(key ? { key } : {}),
  });
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
  /** 单张详情的 hash；空串 = 停在网格。 */
  const [detailHash, setDetailHash] = useState('');
  const layer = useOverlayLayer(packId !== null);

  useEffect(() => {
    setDetailHash('');
  }, [packId]);

  useEffect(() => {
    if (!packId) return;
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        if (detailHash) setDetailHash('');
        else close();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [packId, close, detailHash]);

  if (typeof document === 'undefined' || !packId) return null;

  return createPortal(
    <div className="weq-lightbox-layer weq-anim-fade" style={{ zIndex: layer }} onMouseDown={close}>
      <button className="weq-lightbox-close" type="button" onClick={close} aria-label="关闭">
        <X size={22} />
      </button>
      <div
        className="weq-lightbox-stage weq-anim-pop weq-mface-lightbox"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <MarketFacePackView
          packId={packId}
          activeHash={activeHash}
          detailHash={detailHash}
          onOpenDetail={setDetailHash}
          embedded={false}
        />
      </div>
    </div>,
    document.body,
  );
}

/** 灯箱内容：表情包信息条 + 表情网格（高亮 activeHash）；打开详情时换成单张大图。 */
export function MarketFacePackView({
  packId,
  activeHash = '',
  detailHash = '',
  onOpenDetail,
  embedded = false,
}: {
  packId: string;
  activeHash?: string;
  detailHash?: string;
  onOpenDetail: (hash: string) => void;
  embedded?: boolean;
}): ReactElement {
  const detail = trpc.account.marketEmoji.getPackDetail.useQuery({ packId });
  const fee = FEE_META[detail.data?.feeType ?? 'unknown'];
  const items = detail.data?.items ?? [];
  const index = items.findIndex((item) => item.hash === detailHash);
  const current = index >= 0 ? items[index] : undefined;

  if (current) {
    return (
      <MarketFaceDetail
        packId={packId}
        packName={detail.data?.name || `表情包 ${packId}`}
        item={current}
        index={index}
        total={items.length}
        onBack={() => onOpenDetail('')}
        onPrev={index > 0 ? () => onOpenDetail(items[index - 1]!.hash) : undefined}
        onNext={index < items.length - 1 ? () => onOpenDetail(items[index + 1]!.hash) : undefined}
        embedded={embedded}
      />
    );
  }

  return (
    <div className={`weq-mface-lb-panel${embedded ? ' is-embedded' : ''}`}>
      <div className="weq-mface-lb-head">
        <Store size={16} className="weq-mface-lb-head-icon" />
        <span className="weq-mface-lb-title">{detail.data?.name || `表情包 ${packId}`}</span>
        <em className={`weq-mpack-fee is-${fee.tone}`}>{fee.label}</em>
        {detail.data ? <span className="weq-mface-lb-count">{detail.data.count} 张</span> : null}
        {embedded ? null : (
          <span className="weq-mface-lb-hint">点击任意表情查看大图与解密参数</span>
        )}
      </div>

      {detail.isLoading ? (
        <div className="weq-mface-lb-state">获取这组表情中…</div>
      ) : !detail.data ? (
        <div className="weq-mface-lb-state is-error">无法获取这组表情（网络问题或包不存在）</div>
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
                onOpen={() => onOpenDetail(it.hash)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** 一张表情：TEA 解密后的 GIF；失败显示占位。当前点击的那张高亮。点击看大图。 */
function MarketFaceCell({
  packId,
  hash,
  name,
  active,
  onOpen,
}: {
  packId: string;
  hash: string;
  name: string;
  active: boolean;
  onOpen: () => void;
}): ReactElement {
  const [broken, setBroken] = useState(false);
  return (
    <button
      type="button"
      className={`weq-mface-lb-cell is-button${active ? ' is-active' : ''}`}
      title={name ? `${name} · 点击查看大图` : `${hash} · 点击查看大图`}
      onClick={onOpen}
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
      {name ? <span className="weq-mface-lb-name">{name}</span> : null}
    </button>
  );
}

/**
 * 单张表情详情：大图 + 名称 + 协议参数（pack / hash / enc / key）。
 *
 * 导出给「个性装扮 → 商城表情」的整页浏览器复用（`embedded` 去掉灯箱面板的
 * 边框 / 阴影，直接铺满右栏）。
 */
export function MarketFaceDetail({
  packId,
  packName,
  item,
  index,
  total,
  onBack,
  onPrev,
  onNext,
  embedded = false,
}: {
  packId: string;
  packName: string;
  item: { hash: string; name: string };
  index: number;
  total: number;
  onBack: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  embedded?: boolean;
}): ReactElement {
  const pushToast = useToast((s) => s.push);
  const keyInfo = trpc.account.marketEmoji.getPackKey.useQuery({ packId });
  const key = keyInfo.data?.key ?? '';
  const src = packImageUrl(packId, item.hash, key || undefined);
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [src]);

  const params = useMemo(
    () => [
      { label: 'pack', value: packId },
      { label: 'hash', value: item.hash },
      { label: 'enc', value: 'tea' },
      {
        label: 'key',
        value: key || (keyInfo.isLoading ? '恢复中…' : '未恢复（可用时间戳手动派生）'),
      },
    ],
    [packId, item.hash, key, keyInfo.isLoading],
  );

  async function copy(value: string, label: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      pushToast({ tone: 'success', title: `已复制 ${label}`, message: value, ttl: 4000 });
    } catch {
      pushToast({ tone: 'error', title: '复制失败', detail: '当前环境不允许写剪贴板' });
    }
  }

  return (
    <div className={`weq-mface-lb-panel weq-mface-detail${embedded ? ' is-embedded' : ''}`}>
      <div className="weq-mface-lb-head">
        <button type="button" className="weq-mface-detail-back" onClick={onBack}>
          <ChevronLeft size={15} /> 返回整组
        </button>
        <span className="weq-mface-lb-title">{item.name || item.hash}</span>
        <span className="weq-mface-lb-count">
          {index + 1} / {total}
        </span>
        <MarketImageSave
          key={`${packId}:${item.hash}`}
          packId={packId}
          hash={item.hash}
          name={item.name || item.hash}
        />
      </div>

      <div className="weq-mface-detail-body">
        <div className="weq-mface-detail-stage">
          {onPrev ? (
            <button
              type="button"
              className="weq-mface-detail-nav is-prev"
              onClick={onPrev}
              title="上一张"
              aria-label="上一张"
            >
              <ChevronLeft size={20} />
            </button>
          ) : null}
          {broken ? (
            <div className="weq-mface-lb-state is-error">这张表情解密失败（密钥可能未恢复）</div>
          ) : (
            <img
              className="weq-mface-detail-image"
              src={src}
              alt={item.name || item.hash}
              draggable={false}
              onError={() => setBroken(true)}
            />
          )}
          {onNext ? (
            <button
              type="button"
              className="weq-mface-detail-nav is-next"
              onClick={onNext}
              title="下一张"
              aria-label="下一张"
            >
              <ChevronRight size={20} />
            </button>
          ) : null}
        </div>

        <div className="weq-mface-detail-meta">
          <div className="weq-mface-detail-line">
            <span>表情包</span>
            <strong>{packName}</strong>
          </div>
          <div className="weq-mface-detail-line">
            <span>名称</span>
            <strong>{item.name || '（无名称）'}</strong>
          </div>
          {params.map((param) => (
            <div className="weq-mface-detail-line" key={param.label}>
              <span>{param.label}</span>
              <code title={param.value}>{param.value}</code>
              {param.label === 'key' && key ? (
                <button
                  type="button"
                  className="weq-mface-detail-copy"
                  title="复制密钥"
                  aria-label="复制密钥"
                  onClick={() => void copy(key, 'key')}
                >
                  <Copy size={12} />
                </button>
              ) : null}
            </div>
          ))}
          <div className="weq-mface-detail-line is-url">
            <span>图片地址</span>
            <code title={src}>{src}</code>
            <button
              type="button"
              className="weq-mface-detail-copy"
              title="复制图片地址"
              aria-label="复制图片地址"
              onClick={() => void copy(src, '图片地址')}
            >
              <Copy size={12} />
            </button>
          </div>
          <p className="weq-mface-detail-hint">
            key = md5(str(时间戳))[:16]，时间戳由表情包元数据恢复；拿不到时可在 「本地资源 →
            商城表情包 → 密钥计算器」手输时间戳派生。
          </p>
        </div>
      </div>
    </div>
  );
}
