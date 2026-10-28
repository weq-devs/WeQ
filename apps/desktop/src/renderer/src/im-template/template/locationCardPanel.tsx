// @ts-nocheck
/**
 * 输入框工具栏「位置」菜单里的「发送位置」面板 —— **搜**（腾讯位置服务输入提示）
 * → **选**（地图点一下）→ **填**（逆地址解析给出省市区 / 地址），收齐后走
 * trpc `LocationArk.SsoSendMessage` 发一张位置卡片。
 *
 * 原先这栏是 Ark 面板的一个 tab，而「位置共享（实时位置）」在工具栏另有一个按钮，
 * 两个「位置」入口分裂又长得不一样。合并后工具栏只剩一个位置按钮，点开是两项
 * 菜单：发送位置 → 本面板；共享位置 → `LocationSharePanel`。
 *
 * 只做前端：面板不 import 任何 trpc / 协议，收齐字段后交回 `onSend(payload)`，
 * 由 chatPane 补上「发给哪个会话」。搜索 / 逆地址解析由应用层以 `location` 注入
 * （渲染层 CSP 是 `connect-src 'self'`，而且 key 不该落进前端）。
 *
 * 样式与 Ark 面板同一套外壳（`.ark-panel` / `.ark-body` / `.ark-foot` /
 * `.link-card-*`，见 styles/ark-panel.css），两者看起来就是同一个抽屉。
 */

import { useState } from 'react';
import type { RefObject } from 'react';
import { Loader2, MapPin, RotateCcw, SendHorizontal, X } from 'lucide-react';
import { cn } from './classNames';
import { isDecimalCoordinate, type ArkLocationProvider, type ArkPayload } from './arkCards';
import { ArkLocationTab, emptyLocationDraft, type ArkLocationDraft } from './arkLocationTab';

/** 位置卡片的载荷（形状由 `@weq/trpc` 的 sendLocationArkCard 与乐观卡片共用）。 */
export type LocationCardPayload = Extract<ArkPayload, { type: 'location' }>;

/**
 * 位置那一栏的紧凑预览 —— 不重复画一张静态地图卡片。
 *
 * 上方已经有一张**可交互**的选点地图 + 四个字段，再叠一张静态地图卡预览纯属重复，
 * 还把面板顶得很高、严重挤压输入区。这里只留一行摘要（地址 · 省市区），高度约
 * 40px；真要确认整卡效果，气泡里收到的卡就是最终样子。
 */
function LocationPreviewCompact({ draft }: { draft: ArkLocationDraft }) {
  const address = draft.address.trim();
  const region = draft.region.trim();
  const hasSpot = draft.latitude.trim() !== '' && draft.longitude.trim() !== '';
  const ready = Boolean(address && region && hasSpot);
  return (
    <div className={cn('ark-preview', 'is-compact')} aria-live="polite">
      <div className={cn('ark-loc-preview', !ready && 'is-empty')}>
        <MapPin size={14} strokeWidth={2.1} />
        <span className={cn('ark-loc-preview-text')}>
          {ready ? (
            <>
              <strong>{address}</strong>
              <em>{region}</em>
            </>
          ) : (
            <span className={cn('ark-loc-preview-hint')}>地点名称 · 省市区 · 地图落点</span>
          )}
        </span>
      </div>
    </div>
  );
}

export function LocationCardPanel({
  panelRef,
  disabled,
  disabledHint,
  location,
  onSend,
  onClose,
}: {
  panelRef?: RefObject<HTMLDivElement | null>;
  /** QQ 未在线 / 完全离线等：面板照常填，只是发不出去。 */
  disabled: boolean;
  disabledHint: string;
  /** 地点搜索 / 逆地址解析能力；不传则只有地图与手填。 */
  location?: ArkLocationProvider;
  /** 交回应用层发送；**抛出即失败**，面板保留已填内容并显示原因。 */
  onSend: (payload: LocationCardPayload) => Promise<void>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<ArkLocationDraft>(emptyLocationDraft);
  const [touched, setTouched] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const latOk = isDecimalCoordinate(draft.latitude, 90);
  const lngOk = isDecimalCoordinate(draft.longitude, 180);
  const problem = !draft.address.trim()
    ? '需要地址'
    : !draft.region.trim()
      ? '需要省市区'
      : !latOk || !lngOk
        ? '需要在地图上点选位置（或填合法经纬度）'
        : null;

  async function submit(): Promise<void> {
    setTouched(true);
    if (disabled || sending || problem !== null) return;
    setSending(true);
    setError(null);
    try {
      await onSend({
        type: 'location',
        address: draft.address.trim(),
        region: draft.region.trim(),
        latitude: draft.latitude.trim(),
        longitude: draft.longitude.trim(),
      });
    } catch (err) {
      // 失败不吞内容：错误显示在底栏，用户改一改就能重发。
      setError(err instanceof Error ? err.message : String(err));
      setSending(false);
      return;
    }
    setSending(false);
  }

  const hint = disabled
    ? disabledHint
    : sending
      ? '发送中…'
      : (error ?? (touched ? problem : null));

  return (
    <div
      className={cn('ark-panel', 'location-card-panel')}
      ref={panelRef}
      role="dialog"
      aria-label="发送位置"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      {/* 没有 tab 条：一行标题 + 关闭按钮，占位与 Ark 面板的 tab 行同高。 */}
      <header className={cn('ark-head')}>
        <MapPin size={14} strokeWidth={2.2} />
        <strong>发送位置</strong>
        <button
          type="button"
          className={cn('ark-close')}
          title="关闭"
          aria-label="关闭"
          onClick={onClose}
        >
          <X size={14} strokeWidth={2.4} />
        </button>
      </header>

      <form
        className={cn('ark-body')}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <ArkLocationTab
          value={draft}
          onChange={(patch) => setDraft((current) => ({ ...current, ...patch }))}
          provider={location}
          disabled={sending}
        />
      </form>

      <LocationPreviewCompact draft={draft} />

      <footer className={cn('ark-foot')}>
        <span className={cn('ark-foot-hint', (error || (touched && problem)) && 'is-error')}>
          {sending ? <Loader2 size={11} strokeWidth={2.4} className="ark-spin" /> : null}
          {hint}
        </span>
        <button
          type="button"
          className={cn('link-card-btn', 'ghost')}
          title="清空重填"
          onClick={() => {
            setTouched(false);
            setError(null);
            setDraft(emptyLocationDraft());
          }}
        >
          <RotateCcw size={13} strokeWidth={2.2} />
        </button>
        <button
          type="button"
          className={cn('link-card-btn', 'primary')}
          title={disabled ? disabledHint : '发送这张位置卡片'}
          disabled={disabled || sending}
          onClick={() => void submit()}
        >
          {sending ? (
            <Loader2 size={13} strokeWidth={2.4} className="ark-spin" />
          ) : (
            <SendHorizontal size={13} strokeWidth={2.2} />
          )}
          发送
        </button>
      </footer>
    </div>
  );
}
