/**
 * 聊天商城表情的整包浮层，贴近点击位置显示，不遮挡或锁住会话。
 * 图片优先复用聊天缓存与明文 CDN，失败再尝试 QQTEA；主动浏览不受自动加载偏好阻断。
 * 保留整包网格、单张详情及分级 Esc；详情也供商城整页浏览器复用。
 */

import { ToolbarLabel } from './CompactToolbar';
import { observeCompactToolbar } from './CompactToolbar.shared';
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { OverlayLayer } from './OverlayLayer';
import { ChevronLeft, ChevronRight, Copy, Store, RefreshCw, X } from 'lucide-react';
import type { MarketPackFeeType } from '@weq/service';
import { trpc } from '@renderer/trpc/client';
import { mediaUrl } from '@renderer/lib/resourceUrl';
import { useToast } from './Toast.shared';
import { MarketImageSave } from './MarketImageSave';
import { useDevelopmentDressTools } from '../hooks/useDevelopmentDressTools';
import { RenderDocumentContext, useRenderDocument } from '../lib/renderDocument';
import { useViewState } from '../state/view';
import { useMarketFaceLightbox } from '../state/marketFaceLightbox';
import { useSurfaceEscapeDismissal } from '../lib/surfaceEscape';
import '../styles/market-face-popover.css';

/** 来源徽章元信息（与 MarketPackExplorer 保持一致）。 */
const FEE_META: Record<MarketPackFeeType, { label: string; tone: string }> = {
  free: { label: '免费', tone: 'free' },
  paid: { label: '付费', tone: 'paid' },
  svip: { label: 'SVIP', tone: 'svip' },
  vip: { label: 'VIP', tone: 'vip' },
  unknown: { label: '未知', tone: 'unknown' },
};

/** 浏览已由用户主动打开；不让整包预览依赖密钥恢复完成。 */
function usePackImage(packId: string, hash: string, key?: string) {
  const developmentDressTools = useDevelopmentDressTools();
  const [encrypted, setEncrypted] = useState(false);
  const [broken, setBroken] = useState(false);
  const src = mediaUrl('mface', {
    pack: packId,
    hash,
    intent: 'interactive',
    ...(encrypted ? { enc: 'tea', ...(key ? { key } : {}) } : {}),
  });
  useEffect(() => {
    setEncrypted(false);
    setBroken(false);
  }, [packId, hash]);
  useEffect(() => setBroken(false), [src]);
  return {
    src,
    broken,
    encrypted,
    onError: () => (!developmentDressTools || encrypted ? setBroken(true) : setEncrypted(true)),
    retry: () => {
      setEncrypted(false);
      setBroken(false);
    },
  };
}

/** 挂载一次。渲染当前商城表情包的整组表情网格（若有）。 */
export function MarketFaceLightbox(): ReactElement | null {
  const packId = useMarketFaceLightbox((s) => s.packId);
  const activeHash = useMarketFaceLightbox((s) => s.activeHash);
  const anchor = useMarketFaceLightbox((s) => s.anchor);
  const close = useMarketFaceLightbox((s) => s.close);
  const document = useRenderDocument();
  const account = useViewState((s) => s.openedUin);
  /** 单张详情的 hash；空串 = 停在网格。 */
  const [detailHash, setDetailHash] = useState('');
  const detailRef = useRef<HTMLDivElement>(null);
  useSurfaceEscapeDismissal(detailRef, () => setDetailHash(''), Boolean(packId && detailHash));

  useEffect(() => {
    setDetailHash('');
  }, [packId, activeHash, anchor]);
  // 切号或宿主卸载时释放浮层及原消息锚点。
  useEffect(() => close, [account, close]);

  if (typeof document === 'undefined' || !packId) return null;

  return (
    <RenderDocumentContext.Provider value={anchor?.ownerDocument ?? document}>
      <OverlayLayer
        presentation="popover"
        anchor={anchor}
        anchorPlacement="side"
        className="weq-mface-popover-layer"
        consumeOutsidePress={false}
        onClose={close}
      >
        <div ref={detailRef} className="weq-mface-popover" role="dialog" aria-label="商城表情">
          <button
            type="button"
            className="weq-mface-popover-close"
            aria-label="关闭表情包"
            title="关闭表情包"
            onClick={close}
          >
            <X size={16} />
          </button>
          <MarketFacePackView
            key={packId}
            packId={packId}
            activeHash={activeHash}
            detailHash={detailHash}
            onOpenDetail={setDetailHash}
            embedded
          />
        </div>
      </OverlayLayer>
    </RenderDocumentContext.Provider>
  );
}

/** 表情包信息条与网格（高亮 activeHash）；打开详情时换成单张大图。 */
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
        {detail.data ? (
          <span className="weq-mface-lb-count">
            <span className="weq-number weq-number-inherit">{detail.data.count}</span> 张
          </span>
        ) : null}
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

/** 一张表情：聊天资源优先、QQTEA 回退；全部失败显示占位，点击仍可进入详情重试。 */
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
  const image = usePackImage(packId, hash);
  return (
    <button
      type="button"
      className={`weq-mface-lb-cell is-button${active ? ' is-active' : ''}`}
      title={name ? `${name} · 点击查看大图` : `${hash} · 点击查看大图`}
      onClick={onOpen}
    >
      <span className="weq-mface-lb-stage">
        {image.broken ? (
          <RefreshCw size={18} strokeWidth={1.4} className="weq-mface-lb-fallback" />
        ) : (
          <img
            src={image.src}
            alt={name || hash}
            loading="lazy"
            draggable={false}
            onError={image.onError}
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
  onInsert,
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
  onInsert?: () => void;
}): ReactElement {
  const pushToast = useToast((s) => s.push);
  const developmentDressTools = useDevelopmentDressTools();
  const keyInfo = trpc.account.marketEmoji.getPackKey.useQuery(
    { packId },
    { enabled: developmentDressTools },
  );
  const key = keyInfo.data?.key ?? '';
  const { src, broken, encrypted, onError, retry } = usePackImage(
    packId,
    item.hash,
    key || undefined,
  );

  const params = useMemo(
    () => [
      { label: 'pack', value: packId },
      { label: 'hash', value: item.hash },
      { label: 'enc', value: encrypted ? 'tea' : '无（缓存／明文）' },
      ...(developmentDressTools
        ? [{ label: 'key', value: key || (keyInfo.isLoading ? '恢复中…' : '未恢复') }]
        : []),
    ],
    [packId, item.hash, key, keyInfo.isLoading, encrypted, developmentDressTools],
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
      <div ref={observeCompactToolbar} className="weq-mface-lb-head">
        <button title="返回整组" type="button" className="weq-mface-detail-back" onClick={onBack}>
          <ChevronLeft size={15} />
          <ToolbarLabel>返回整组</ToolbarLabel>
        </button>
        <span className="weq-mface-lb-title">{item.name || item.hash}</span>
        <span className="weq-mface-lb-count">
          <span className="weq-number weq-number-inherit">{index + 1}</span> /{' '}
          <span className="weq-number weq-number-inherit">{total}</span>
        </span>
        {onInsert ? (
          <button type="button" className="weq-emb-download" onClick={onInsert}>
            插入
          </button>
        ) : (
          <MarketImageSave
            key={`${packId}:${item.hash}`}
            packId={packId}
            hash={item.hash}
            name={item.name || item.hash}
          />
        )}
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
            <div className="weq-mface-lb-state is-error">
              <p>这张表情暂时无法加载</p>
              <button type="button" className="weq-set-btn" onClick={retry}>
                <RefreshCw size={14} /> 重试加载
              </button>
            </div>
          ) : (
            <img
              className="weq-mface-detail-image"
              src={src}
              alt={item.name || item.hash}
              draggable={false}
              onError={onError}
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
