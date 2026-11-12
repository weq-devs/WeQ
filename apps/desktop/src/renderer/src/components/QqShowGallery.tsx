/**
 * QQ 秀展柜 —— 资料卡点头像打开的一个浮层。
 *
 * 数据来源不是 `0xFE1_3`（它只回当前形象），而是直接枚举 CDN 上的历史版本号：
 * `images/<uin>/<n>.png`，n 从 101 起单调递增，每次保存形象 +1、旧版长期留存。
 * 主进程的 `account.dressup.qqShowGallery` 订阅负责并发探测，**命中一张推一张**，
 * 这里接到就渲染，不攒到最后。
 *
 * 判定结尾靠「连续 10 个序号都取不到」（见 `@weq/service` 的 `scanQqShowGallery`）：
 * 号段中间的偶发缺号不会误停，但也因此**不保证 100% 完整** —— 界面上如实写出来。
 *
 * 内容去重在主进程做（按字节 md5）：同一次保存产生的多张、或重复保存同一套形象，
 * 展柜里只出现一张。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ImageOff, Loader2, Maximize2, RefreshCw, Sparkles, X } from 'lucide-react';
import { client } from '../trpc/client';
import { openMediaPreview } from './mediaPreviewStore';
import { qqShowUrl } from '../lib/resourceUrl';
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

  const subRef = useRef<{ unsubscribe(): void } | null>(null);

  useEffect(() => {
    setItems([]);
    setScanned(START_REVISION - 1);
    setCeiling(START_REVISION - 1);
    setError('');
    setTruncated(false);
    setRunning(true);

    const sub = client.account.dressup.qqShowGallery.subscribe(
      { uin },
      {
        onData: (event) => {
          if (event.kind === 'item') {
            setItems((prev) => {
              // 主进程已按 md5 去重；这里再挡一次「同一序号重复推」。
              if (prev.some((item) => item.revision === event.item.revision)) return prev;
              return [...prev, event.item].sort((a, b) => b.revision - a.revision);
            });
            setScanned(event.scanned);
            setCeiling(event.ceiling);
            return;
          }
          if (event.kind === 'progress') {
            setScanned(event.scanned);
            setCeiling(event.ceiling);
            return;
          }
          setRunning(false);
          setScanned(event.scanned);
          setTruncated(event.truncated);
          if (event.error) setError(event.error);
        },
        onError: (cause) => {
          setRunning(false);
          setError(cause instanceof Error ? cause.message : String(cause));
        },
      },
    );
    subRef.current = sub;
    return () => {
      sub.unsubscribe();
      subRef.current = null;
    };
  }, [uin, runId]);

  const stop = useCallback(() => {
    subRef.current?.unsubscribe();
    subRef.current = null;
    setRunning(false);
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

  const highest = items[0]?.revision ?? currentRevision;
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
        <header className="weq-qqshow-gallery-head">
          <div className="weq-qqshow-gallery-title">
            <Sparkles size={17} strokeWidth={1.9} />
            <h2 id="weq-qqshow-gallery-title">QQ 秀展柜</h2>
            <span className="weq-qqshow-gallery-sub">{name}</span>
          </div>
          <div className="weq-qqshow-gallery-tools">
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
              <button type="button" className="weq-qqshow-gallery-btn" onClick={stop}>
                停止
              </button>
            ) : (
              <button
                type="button"
                className="weq-qqshow-gallery-btn"
                onClick={() => setRunId((id) => id + 1)}
                title="重新扫描（CDN 可能补上了之前缺号的版本）"
              >
                <RefreshCw size={12} />
                重扫
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
          {running
            ? `从 #${START_REVISION} 起并发扫描，连续 ${EMPTY_STOP} 个版本取不到才收尾 · ${ceilingLabel}`
            : truncated
              ? `扫描到上限（#${scanned}）仍未收尾，结果可能不完整`
              : `扫到 #${scanned}，${ceilingLabel} · 历史上传失败的版本会缺号，展柜跳过它们`}
        </p>

        <div className="weq-qqshow-gallery-body">
          {error ? (
            <div className="weq-qqshow-gallery-state">
              <ImageOff size={26} strokeWidth={1.6} />
              <p>展柜没打开</p>
              <span>{error}</span>
              <button type="button" onClick={() => setRunId((id) => id + 1)}>
                重试
              </button>
            </div>
          ) : items.length === 0 && !running ? (
            <div className="weq-qqshow-gallery-state">
              <ImageOff size={26} strokeWidth={1.6} />
              <p>没有找到历史形象</p>
              <span>
                这个人可能没保存过 QQ 秀，或者历史图已被 CDN 清理（从 #{START_REVISION}{' '}
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
                    item.revision === highest ? ' is-current' : ''
                  }`}
                  onClick={() => open(item)}
                  title={`查看大图 · #${item.revision}`}
                >
                  <span className="weq-qqshow-gallery-media">
                    <img
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
                    <strong>#{item.revision}</strong>
                    {item.revision === highest ? <em>当前</em> : null}
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
