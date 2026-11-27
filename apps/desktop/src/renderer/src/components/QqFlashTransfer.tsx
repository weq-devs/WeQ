/**
 * Renders a `markdown` element that carries `flashTransferInfo` as a QQ 闪传
 * (flash transfer) file card, faithfully porting the "Flash Transfer Render"
 * demo. The whole card is reconstructed from the element's `markdownContent`,
 * which for these messages is a single markdown link:
 *
 *   [闪传](mqqapi://markdown/node?nodeType=richui&json=<url-encoded JSON>)
 *
 * The engine: pull the `json` query param out of that mqqapi URL, JSON.parse it,
 * then recursively flatten the rich-ui attribute tree into a `viewId → node`
 * dictionary so we can read `title` / `image` / `desc` / `tailIcon` / `tailText`
 * regardless of how deeply they're nested.
 *
 * 点击卡片不再换 sharelink 开 webview，而是直接打开文件浏览弹窗
 * （FlashTransferViewer，匿名 HTTP2RPC 拉列表）。「分享」按钮在浏览弹窗里。
 *
 * 另一条降级路径见 {@link QqFlashTransferLink}：Linux / 鸿蒙端收到的闪传没有卡片
 * 元素、没有 filesetId，只有一条带分享短码的纯文本，不走浏览弹窗。
 */

import { useMemo, useState, type ReactElement } from 'react';
import { cachedAvatarUrl } from '../lib/avatarCache';
import { FlashShareDialog } from './FlashShareDialog';
import { FlashTransferViewer } from './FlashTransferViewer';
import { useToast } from './Toast.shared';
import { formatBytes } from '../lib/format';
import { parseFlashTransfer } from './QqFlashTransfer.shared';
import { CardPreviewImage } from './CardPreviewImage';
import { TransferRing } from './TransferRing';
import { useTransferProgress } from '../lib/transferActivity';
import { flashFilesetTransferTarget } from '../../../shared/transfer_progress';

// ---- desc fallback from the real flashTransferInfo -----------------------

const FLASH_EXPIRE_DAYS = 14;

/** "X 天后过期" computed from createTime (seconds); falls back to the 14d default. */
function expiryText(createTimeSec: number): string {
  if (!Number.isFinite(createTimeSec) || createTimeSec <= 0) return `${FLASH_EXPIRE_DAYS} 天后过期`;
  const expireMs = (createTimeSec + FLASH_EXPIRE_DAYS * 86400) * 1000;
  const daysLeft = Math.ceil((expireMs - Date.now()) / 86400000);
  if (daysLeft <= 0) return '已过期';
  return `${daysLeft} 天后过期`;
}

/** Standard 闪传 desc line: "<size> · 1 项 · <expiry>". */
function buildDesc(info: Record<string, unknown> | undefined): string {
  const parts: string[] = [];
  const size = formatBytes(Number(info?.fileBytes));
  if (size) parts.push(size);
  parts.push('1 项');
  parts.push(expiryText(Number(info?.createTime)));
  return parts.join(' · ');
}

/** 从 flashTransferInfo / mqqrouter schema 里兜底拿 filesetId。 */
function resolveFilesetId(info: Record<string, unknown>, schema: string): string {
  const direct = typeof info.fileSetId === 'string' ? info.fileSetId : '';
  if (direct) return direct;
  const m = schema.match(/fileset_id=([a-zA-Z0-9-]+)/);
  return m?.[1] ?? '';
}

// ---- the card ------------------------------------------------------------

/**
 * 卡片外壳：真卡片（{@link QqFlashTransfer}）与分享短码降级卡片
 * （{@link QqFlashTransferLink}）共用同一套 DOM 与样式。
 */
function FlashCardView({
  title,
  desc,
  cover,
  fallbackCover,
  tailIcon,
  tailText,
  onOpen,
  id,
}: {
  title: string;
  desc: string;
  cover: string;
  fallbackCover: string;
  tailIcon: string;
  tailText: string;
  onOpen: () => void;
  id?: string;
}): ReactElement {
  const upload = useTransferProgress(id ? flashFilesetTransferTarget(id, 'upload') : undefined);
  const download = useTransferProgress(id ? flashFilesetTransferTarget(id, 'download') : undefined);
  return (
    <div
      className="weq-flash-card"
      role="button"
      tabIndex={0}
      title="点击查看闪传文件"
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen();
        }
      }}
    >
      {cover ? (
        <div className="weq-flash-media-box weq-media-frame">
          <CardPreviewImage
            className="weq-flash-cover"
            src={cover}
            fallbackSrc={fallbackCover}
            mediaLoading
          />
        </div>
      ) : null}
      <div className="weq-flash-content">
        <div className="weq-flash-title">{title}</div>
        <div className="weq-flash-desc">{desc}</div>
        <div className="weq-flash-divider" />
        <div className="weq-flash-footer">
          {tailIcon ? (
            <img className="weq-flash-tail-icon" src={tailIcon} alt="" loading="lazy" />
          ) : null}
          <span>{tailText}</span>
          {upload?.phase === 'failed' ? (
            <span role="status">文件上传失败</span>
          ) : upload ? (
            <TransferRing progress={upload} label="闪传文件上传进度" size={17} />
          ) : null}
          {download && <TransferRing progress={download} label="闪传下载进度" size={17} />}
        </div>
      </div>
    </div>
  );
}

export function QqFlashTransfer({
  markdownContent,
  info,
}: {
  markdownContent: string;
  info: unknown;
}): ReactElement | null {
  const view = useMemo(() => parseFlashTransfer(markdownContent), [markdownContent]);
  const pushToast = useToast((s) => s.push);
  const [viewerOpen, setViewerOpen] = useState(false);
  if (!view) return null;

  const infoObj = (info ?? {}) as Record<string, unknown>;
  const filesetId = resolveFilesetId(infoObj, view.schema);
  const desc = view.descText || buildDesc(infoObj);
  const cover = view.coverImg ?? '';
  const fallbackCover = view.failedSrc ?? '';
  const tailIcon = view.tailIcon ? (cachedAvatarUrl(view.tailIcon) ?? view.tailIcon) : '';

  /** 点击卡片：直接打开文件浏览弹窗。 */
  function handleOpen(): void {
    if (!filesetId) {
      pushToast({
        tone: 'warning',
        message: '这条闪传消息缺少 filesetId，无法查看文件',
        detail: '该消息可能已过期，或来自不支持的旧版本客户端。',
      });
      return;
    }
    setViewerOpen(true);
  }

  return (
    <>
      <FlashCardView
        title={view.title}
        desc={desc}
        cover={cover}
        fallbackCover={fallbackCover}
        tailIcon={tailIcon}
        tailText={view.tailText}
        id={filesetId}
        onOpen={handleOpen}
      />
      {viewerOpen ? (
        <FlashTransferViewer
          filesetId={filesetId}
          title={view.title}
          onClose={() => setViewerOpen(false)}
        />
      ) : null}
    </>
  );
}

/**
 * 分享短码降级卡片 —— Linux / 鸿蒙端 QQ 收不到闪传卡片：服务端把它降级成一条纯文本，
 * 卡片元素、`flashTransferInfo`、filesetId 全都没有，只剩 `qfile.qq.com/q/<code>`。
 *
 * 这里**不去反查 filesetId**（那只能去抠分享页的 SSR，等于把对方的网页当接口用，太脆），
 * 而是用短码本来就自带的东西 —— 它是个**公开分享链接**。点卡片直接把这一页嵌进
 * {@link FlashShareDialog}（页面上就能浏览 / 下载），所以这条路径零额外请求、不需要
 * filesetId，也不会因为 qfile 改版而悄悄失效。
 *
 * 对账另说：短码在 MainView 里当乐观卡片的签名用（见 lib/flashShare）。
 */
export function QqFlashTransferLink({ code }: { code: string }): ReactElement {
  const [shareOpen, setShareOpen] = useState(false);
  return (
    <>
      <FlashCardView
        title="闪传文件"
        desc="QQ闪传分享 · 点击打开查看"
        cover=""
        fallbackCover=""
        tailIcon=""
        tailText="QQ闪传"
        id={code}
        onOpen={() => setShareOpen(true)}
      />
      {shareOpen ? (
        <FlashShareDialog
          title="QQ闪传"
          url={`https://qfile.qq.com/q/${encodeURIComponent(code)}`}
          onClose={() => setShareOpen(false)}
        />
      ) : null}
    </>
  );
}
export type { FlashTransferView } from './QqFlashTransfer.shared';
