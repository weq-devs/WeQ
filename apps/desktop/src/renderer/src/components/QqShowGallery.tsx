/**
 * QQ 秀展柜 —— 资料卡点头像打开的一个浮层。
 *
 * 数据来源不是 `0xFE1_3`（它只回当前形象），而是直接枚举 CDN 上的历史版本号：
 * `images/<uin>/<n>.png`，n 从 101 起单调递增，每次保存形象 +1、旧版长期留存。
 * 主进程的 `account.dressup.qqShowGallery` 订阅负责并发探测，**命中一张推一张**，
 * 这里按探测批次追加，已经显示的卡片不随新结果换位。
 *
 * 判定结尾靠「连续 10 个序号都取不到」（见 `@weq/service` 的 `scanQqShowGallery`）：
 * 号段中间的偶发缺号不会误停，但也因此**不保证 100% 完整** —— 界面上如实写出来。
 *
 * 内容去重在主进程做（按字节 md5）：同一次保存产生的多张、或重复保存同一套形象，
 * 展柜里只出现一张。
 */

import { ToolbarLabel } from './CompactToolbar';
import { observeCompactToolbar } from './CompactToolbar.shared';
import { NumericText } from './NumericText';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ImageOff, Loader2, Maximize2, RefreshCw, Sparkles, Square, X } from 'lucide-react';
import { client } from '../trpc/client';
import { openMediaPreview } from './mediaPreviewStore.shared';
import { qqShowUrl } from '../lib/resourceUrl';
import { ShimmerImage } from './ShimmerImage';
import { OverlayLayer } from './OverlayLayer';
import '../styles/qqshow-gallery.css';

/** 与 `@weq/service` 的常量保持一致（不在渲染层 import service，避免把 Node 侧带进包）。 */
const START_REVISION = 101;
const EMPTY_STOP = 10;

interface GalleryItem {
  revision: number;
  url: string;
  md5: string;
  bytes: number;
}

interface Props {
  uin: string;
  name: string;
  /** 当前形象序号（来自资料卡已有的 QQ 秀查询）；拿不到就传 null。 */
  currentRevision: number | null;
  onClose: () => void;
  anchor?: HTMLElement | null;
}

export function QqShowGallery({
  uin,
  name,
  currentRevision,
  onClose,
  anchor,
}: Props): React.ReactElement {
  const [items, setItems] = useState<GalleryItem[]>([]);
  const [scanned, setScanned] = useState(START_REVISION - 1);
  const [ceiling, setCeiling] = useState(START_REVISION - 1);
  const [running, setRunning] = useState(true);
  const [error, setError] = useState('');
  const [truncated, setTruncated] = useState(false);
  const [runId, setRunId] = useState(0);

  const stopRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    setItems([]);
    setScanned(START_REVISION - 1);
    setCeiling(START_REVISION - 1);
    setError('');
    setTruncated(false);
    setRunning(true);

    const seen = new Set<number>();
    let pending: GalleryItem[] = [];
    let stopped = false;
    const flush = () => {
      if (!pending.length) return;
      const batch = pending.sort((a, b) => a.revision - b.revision);
      pending = [];
      setItems((previous) => [...previous, ...batch]);
    };
    const sub = client.account.dressup.qqShowGallery.subscribe(
      { uin },
      {
        onData: (event) => {
          if (stopped) return;
          if (event.kind === 'item') {
            if (!seen.has(event.item.revision)) {
              seen.add(event.item.revision);
              pending.push(event.item);
            }
            return;
          }
          flush();
          setScanned(event.scanned);
          if (event.kind === 'progress') {
            setCeiling(event.ceiling);
            return;
          }
          setRunning(false);
          setTruncated(event.truncated);
          if (event.error) setError(event.error);
        },
        onError: (cause) => {
          if (stopped) return;
          flush();
          setRunning(false);
          setError(cause instanceof Error ? cause.message : String(cause));
        },
      },
    );
    const unsubscribe = () => {
      if (stopped) return;
      stopped = true;
      sub.unsubscribe();
    };
    stopRef.current = () => {
      unsubscribe();
      flush();
      setRunning(false);
    };
    return () => {
      unsubscribe();
      stopRef.current = null;
    };
  }, [uin, runId]);

  const stop = useCallback(() => {
    stopRef.current?.();
  }, []);

  const open = useCallback(
    (item: GalleryItem) => {
      openMediaPreview({
        items: [
          {
            key: qqShowUrl(item.url, item.revision),
            kind: 'image',
            src: qqShowUrl(item.url, item.revision),
            title: `${name} 的 QQ 秀 · #${item.revision}`,
          },
        ],
      });
    },
    [name],
  );

  const current = currentRevision ?? items.at(-1)?.revision;
  const ceilingLabel = `已确认到 #${ceiling > 0 ? ceiling : '—'}`;

  return (
    <OverlayLayer
      presentation={anchor ? 'popover' : 'modal'}
      anchor={anchor}
      anchorPlacement="side"
      title="QQ 秀展柜"
      className={anchor ? 'weq-qqshow-gallery-popover' : 'weq-qqshow-gallery-scrim'}
      onClose={onClose}
    >
      <section
        className="weq-qqshow-gallery"
        role="dialog"
        aria-modal={anchor ? undefined : true}
        aria-labelledby="weq-qqshow-gallery-title"
      >
        <header ref={observeCompactToolbar} className="weq-qqshow-gallery-head">
          <div className="weq-qqshow-gallery-title">
            <Sparkles size={17} strokeWidth={1.9} />
            <h2 id="weq-qqshow-gallery-title">QQ 秀展柜</h2>
            <span className="weq-qqshow-gallery-sub">{name}</span>
          </div>
          <div className="weq-qqshow-gallery-tools" data-toolbar-group="">
            <span className="weq-qqshow-gallery-count">
              {running ? (
                <>
                  <Loader2 size={12} className="weq-qqshow-spin" />
                  已找到 {items.length} 张
                </>
              ) : (
                <>共 {items.length} 张</>
              )}
            </span>
            {running ? (
              <button title="停止" type="button" className="weq-qqshow-gallery-btn" onClick={stop}>
                <Square size={12} aria-hidden />
                <ToolbarLabel>停止</ToolbarLabel>
              </button>
            ) : (
              <button
                type="button"
                className="weq-qqshow-gallery-btn"
                onClick={() => setRunId((id) => id + 1)}
                title="重新扫描（CDN 可能补上了之前缺号的版本）"
              >
                <RefreshCw size={12} />
                <ToolbarLabel>重扫</ToolbarLabel>
              </button>
            )}
            <button
              type="button"
              className="weq-qqshow-gallery-close"
              onClick={onClose}
              aria-label="关闭"
              title="关闭"
            >
              <X size={15} strokeWidth={2} />
            </button>
          </div>
        </header>

        <p className="weq-qqshow-gallery-hint">
          <NumericText>
            {running
              ? `从 #${START_REVISION} 起并发扫描，连续 ${EMPTY_STOP} 个版本取不到才收尾 · ${ceilingLabel}`
              : truncated
                ? `扫描到上限（#${scanned}）仍未收尾，结果可能不完整`
                : `扫到 #${scanned}，${ceilingLabel} · 历史上传失败的版本会缺号，展柜跳过它们`}
          </NumericText>
        </p>

        <div className="weq-qqshow-gallery-body">
          {error ? (
            <div className="weq-qqshow-gallery-state">
              <ImageOff size={26} strokeWidth={1.6} />
              <p>展柜没打开</p>
              <span>{error}</span>
              <button
                type="button"
                onClick={() => setRunId((id) => id + 1)}
                className="weq-retry-button"
              >
                <RefreshCw size={14} aria-hidden />
                重试
              </button>
            </div>
          ) : items.length === 0 && !running ? (
            <div className="weq-qqshow-gallery-state">
              <ImageOff size={26} strokeWidth={1.6} />
              <p>没有找到历史形象</p>
              <span>
                这个人可能没保存过 QQ 秀，或者历史图已被 CDN 清理（从 #
                <span className="weq-number weq-number-inherit">{START_REVISION}</span>{' '}
                起没有一张能取到）。
              </span>
            </div>
          ) : (
            <div className="weq-qqshow-gallery-grid">
              {items.map((item) => (
                <button
                  key={item.md5}
                  type="button"
                  className={`weq-qqshow-gallery-card${
                    item.revision === current ? ' is-current' : ''
                  }`}
                  onClick={() => open(item)}
                  title={`查看大图 · #${item.revision}`}
                >
                  <span className="weq-qqshow-gallery-media weq-media-frame">
                    <ShimmerImage
                      src={qqShowUrl(item.url, item.revision)}
                      alt={`${name} 的 QQ 秀 #${item.revision}`}
                      loading="lazy"
                      decoding="async"
                    />
                    <span className="weq-qqshow-gallery-zoom" aria-hidden>
                      <Maximize2 size={14} strokeWidth={2} />
                    </span>
                  </span>
                  <span className="weq-qqshow-gallery-meta">
                    <strong>
                      #<span className="weq-number weq-number-inherit">{item.revision}</span>
                    </strong>
                    {item.revision === current ? <em>当前</em> : null}
                  </span>
                </button>
              ))}
              {/* 扫描中留一个呼吸位，让人知道还没完，而不是「就这些了」。 */}
              {running ? (
                <div className="weq-qqshow-gallery-pending" aria-hidden>
                  <Loader2 size={18} className="weq-qqshow-spin" />
                </div>
              ) : null}
            </div>
          )}
        </div>
      </section>
    </OverlayLayer>
  );
}
