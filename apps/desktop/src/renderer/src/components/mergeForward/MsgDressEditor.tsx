/**
 * MsgDressEditor —— 合并转发里给**单条预览消息**改装扮（列 40801）的小卡片。
 *
 * 三行输入（气泡 / 挂件 / 字体）+ 一个实时预览。点某行的「商城」会再叠一张更小的
 * 灯箱卡片去商城挑（复用个性装扮那套 rank / search，排行离线可用）。
 *
 * 字体按真机回退槽写：`41525 = 0`、`41531 = bit16 | swap16(itemId)`。item_id 反推
 * 不回槽点与 bit16，所以只能默认回退槽，个别机型可能不生效 —— 卡片里只挂一行小字
 * 提示，不展开讲。
 *
 * 每次输入都立刻回写上层草稿，所以背后的预览消息是实时刷新的。
 */

import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import {
  Check,
  Gem,
  Loader2,
  Palette,
  Search,
  Sparkles,
  Trophy,
  Type,
  WifiOff,
  X,
} from 'lucide-react';
import type { DressMallItem } from '@weq/service';
import { trpc } from '../../trpc/client';
import { useOverlayLayer } from '../../lib/overlayStack';
import { dressUrl } from '../../lib/resourceUrl';
import { closeFromScrim } from '../../im-template/template/modalUtils';
import { cn } from '../../im-template/template/classNames';
import { QqMessageContent } from '../QqMessageContent';
import { QqAvatar } from '../QqAvatar';
import { useMsgDecoration } from '../../hooks/useMsgDecoration';
import { useBubbleFontFx } from '../../hooks/useBubbleFontFx';
import { segsToRenderElements, type MfDecoration, type MfSeg } from './model';

type DressKind = 'bubble' | 'font' | 'widget';

/**
 * Escape 只让**最上层**的浮层响应。背景的合并转发对话框也挂了文档级 Escape 监听，
 * 这里在 capture 阶段拦下并阻止冒泡，避免一次 Esc 把两层一起关掉。
 */
function useTopEscape(enabled: boolean, onClose: () => void): void {
  useEffect(() => {
    if (!enabled) return;
    function onKey(event: KeyboardEvent): void {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onClose();
    }
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [enabled, onClose]);
}

const KIND_META: Record<DressKind, { label: string; icon: ReactElement }> = {
  bubble: { label: '气泡', icon: <Palette size={14} /> },
  widget: { label: '挂件', icon: <Gem size={14} /> },
  font: { label: '字体', icon: <Type size={14} /> },
};

/**
 * itemId → 回退槽（41531）原值：低 16 位做字节序交换，再置 bit16。
 * 与 codec 的 `decodeFallbackFontId` 互为逆运算（swap 是对合）。
 */
function encodeFallbackFont(itemId: number): number {
  const swap = ((itemId & 0xff) << 8) | ((itemId >>> 8) & 0xff);
  return 0x10000 | swap;
}

/** 一次装扮编辑过程中会碰到的字段（原始槽位保留在 MfDecoration 里）。 */
function normalize(dec: MfDecoration): MfDecoration | undefined {
  if (dec.bubbleId <= 0 && dec.fontId <= 0 && dec.widgetId <= 0) return undefined;
  return dec;
}

// ───────────────────────────── 实时预览 ─────────────────────────────

/** 一张样例气泡，按当前装扮渲染（与预览行同一条装扮注入链）。 */
function DressPreview({
  decoration,
  uin,
}: {
  decoration: MfDecoration;
  /** 这条消息的发送人 uin —— 头像与挂件都挂在它上面。 */
  uin?: string;
}): ReactElement {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const msgDec = useMsgDecoration({
    bubbleId: decoration.bubbleId,
    fontId: decoration.fontId,
    widgetId: decoration.widgetId,
  });
  const fontFxAttr = useBubbleFontFx(msgDec.fontFx, rowRef);
  const previewSegs = useMemo<MfSeg[]>(
    () => [{ t: 'text', id: 'dress-preview', text: '装扮预览 Aa 123' }],
    [],
  );
  const elements = useMemo(() => segsToRenderElements(previewSegs), [previewSegs]);

  return (
    <div
      ref={rowRef}
      className="weq-forward-row weq-mf-dress-preview"
      data-bubble={msgDec.bubbleId || undefined}
      data-font={msgDec.fontId || undefined}
      data-fontfx={fontFxAttr}
      data-widget={msgDec.widget ? decoration.widgetId : undefined}
    >
      <div className="weq-forward-avatar weq-mf-dress-preview-avatar">
        <QqAvatar uin={uin} size={40} className="weq-mf-avatar-img" />
        <span className="weq-avatar-pendant-img" aria-hidden />
      </div>
      <div className="weq-forward-bubble weq-mf-bubble qq-bubble-shell">
        <QqMessageContent elements={elements as never} sendTimeMs={0} msgId="dress-preview" />
      </div>
    </div>
  );
}

// ───────────────────────────── 装扮编辑卡片 ─────────────────────────────

export function MsgDressEditor({
  decoration,
  uin,
  onChange,
  onClose,
}: {
  decoration: MfDecoration | undefined;
  /** 这条消息的发送人 uin —— 决定预览里的头像与挂件。 */
  uin?: string;
  /** 每次改动立即回写（含全 0 → 传 undefined 让上层删掉装扮）。 */
  onChange: (decoration: MfDecoration | undefined) => void;
  onClose: () => void;
}): ReactElement {
  const layer = useOverlayLayer(true);

  const [dec, setDec] = useState<MfDecoration>(
    decoration ?? { bubbleId: 0, fontId: 0, widgetId: 0 },
  );
  /** 展开了哪个类别的商城灯箱。 */
  const [pickFor, setPickFor] = useState<DressKind | null>(null);
  /** 从商城选中后带回的款名（仅用于展示）。 */
  const [names, setNames] = useState<Partial<Record<DressKind, string>>>({});

  // 商城灯箱打开时把 Escape 让给它。
  useTopEscape(pickFor === null, onClose);

  function commit(next: MfDecoration): void {
    setDec(next);
    onChange(normalize(next));
  }

  function setNumber(kind: DressKind, raw: string): void {
    const value = Math.max(0, Math.floor(Number(raw.replace(/[^\d]/g, '')) || 0));
    if (kind === 'font') {
      // 字体一律走回退槽 + bit16=1，不保留原先的优先槽。
      commit({
        ...dec,
        fontId: value,
        fontId1Raw: 0,
        fontId2Raw: value > 0 ? encodeFallbackFont(value) : 0,
      });
      return;
    }
    commit({ ...dec, [kind === 'bubble' ? 'bubbleId' : 'widgetId']: value });
  }

  function clear(kind: DressKind): void {
    if (kind === 'font') commit({ ...dec, fontId: 0, fontId1Raw: 0, fontId2Raw: 0 });
    else commit({ ...dec, [kind === 'bubble' ? 'bubbleId' : 'widgetId']: 0 });
    setNames((cur) => ({ ...cur, [kind]: undefined }));
  }

  const hasAny = dec.bubbleId > 0 || dec.fontId > 0 || dec.widgetId > 0;
  const rows: Array<{ kind: DressKind; value: number }> = [
    { kind: 'bubble', value: dec.bubbleId },
    { kind: 'widget', value: dec.widgetId },
    { kind: 'font', value: dec.fontId },
  ];

  return createPortal(
    <div
      className="weq-mf-dress-layer"
      style={{ zIndex: layer }}
      role="presentation"
      onMouseDown={closeFromScrim(onClose)}
    >
      <div className="weq-mf-dress-card" role="dialog" aria-modal="true" aria-label="编辑装扮">
        <header className="weq-mf-dress-head">
          <span className="weq-mf-dress-head-icon">
            <Sparkles size={15} />
          </span>
          <strong>编辑装扮</strong>
          <button type="button" className="weq-mf-dress-x" title="关闭" onClick={onClose}>
            <X size={15} strokeWidth={2} />
          </button>
        </header>

        <div className="weq-mf-dress-preview-wrap">
          <DressPreview decoration={dec} uin={uin} />
        </div>

        <div className="weq-mf-dress-fields">
          {rows.map(({ kind, value }) => (
            <div className="weq-mf-dress-field" key={kind}>
              <span className="weq-mf-dress-field-label">
                {KIND_META[kind].icon}
                {KIND_META[kind].label}
              </span>
              <input
                className="weq-mf-input mono weq-mf-dress-input"
                inputMode="numeric"
                placeholder="id"
                value={value > 0 ? String(value) : ''}
                onChange={(e) => setNumber(kind, e.target.value)}
                aria-label={`${KIND_META[kind].label} id`}
              />
              <span className="weq-mf-dress-name" title={names[kind]}>
                {names[kind] ?? ''}
              </span>
              <button type="button" className="weq-mf-dress-mall" onClick={() => setPickFor(kind)}>
                <Search size={12} />
                商城
              </button>
              <button
                type="button"
                className="weq-mf-dress-clear"
                title="清除"
                disabled={value <= 0}
                onClick={() => clear(kind)}
              >
                <X size={13} strokeWidth={2} />
              </button>
            </div>
          ))}
        </div>

        {dec.fontId > 0 ? (
          <p className="weq-mf-dress-note">字体按回退槽写入，个别机型可能不生效。</p>
        ) : null}

        <footer className="weq-mf-dress-foot">
          <button
            type="button"
            className="weq-mf-soft"
            disabled={!hasAny}
            onClick={() => {
              commit({ bubbleId: 0, fontId: 0, widgetId: 0 });
              setNames({});
            }}
          >
            清除全部
          </button>
          <span className="weq-mf-inline-spacer" />
          <button type="button" className="weq-mf-primary" onClick={onClose}>
            完成
          </button>
        </footer>
      </div>

      {pickFor ? (
        <DressMallPicker
          kind={pickFor}
          currentId={
            pickFor === 'bubble' ? dec.bubbleId : pickFor === 'font' ? dec.fontId : dec.widgetId
          }
          onBack={() => setPickFor(null)}
          onPick={(item) => {
            setNumber(pickFor, String(item.itemId));
            setNames((cur) => ({ ...cur, [pickFor]: item.name }));
            setPickFor(null);
          }}
        />
      ) : null}
    </div>,
    document.body,
  );
}

// ───────────────────────────── 商城灯箱 ─────────────────────────────

/** 商城排行榜 / 搜索的小灯箱 —— 复用个性装扮那套数据源，排行离线可用。 */
function DressMallPicker({
  kind,
  currentId,
  onPick,
  onBack,
}: {
  kind: DressKind;
  currentId: number;
  onPick: (item: DressMallItem) => void;
  onBack: () => void;
}): ReactElement {
  const layer = useOverlayLayer(true);
  useTopEscape(true, onBack);
  const [draft, setDraft] = useState('');
  const [keyword, setKeyword] = useState('');

  const state = trpc.account.dressup.getState.useQuery();
  const online = state.data?.qqOnline ?? false;

  const searching = keyword.length > 0;
  const rank = trpc.account.dressup.rank.useQuery({ kind }, { enabled: !searching });
  const search = trpc.account.dressup.search.useQuery(
    { kind, keyword },
    { enabled: searching && online, retry: false },
  );

  const query = searching ? search : rank;
  const items = searching ? (search.data?.items ?? []) : (rank.data?.items ?? []);

  return createPortal(
    <div
      className="weq-mf-dress-layer weq-mf-dress-layer-sub"
      style={{ zIndex: layer }}
      role="presentation"
      onMouseDown={closeFromScrim(onBack)}
    >
      <div className="weq-mf-mall-card" role="dialog" aria-modal="true" aria-label="选择装扮">
        <header className="weq-mf-dress-head">
          <span className="weq-mf-dress-head-icon">{KIND_META[kind].icon}</span>
          <strong>选择{KIND_META[kind].label}</strong>
          <button type="button" className="weq-mf-dress-x" title="返回" onClick={onBack}>
            <X size={15} strokeWidth={2} />
          </button>
        </header>

        <form
          className="weq-mf-mall-search"
          onSubmit={(e) => {
            e.preventDefault();
            if (!draft.trim()) return;
            setKeyword(draft.trim());
          }}
        >
          <Search size={14} strokeWidth={1.8} />
          <input
            className="weq-mf-mall-search-input"
            value={draft}
            spellCheck={false}
            placeholder={online ? '搜索装扮名，回车确认' : '搜索需要登录 QQ 客户端'}
            disabled={!online}
            onChange={(e) => setDraft(e.target.value)}
          />
          {keyword ? (
            <button
              type="button"
              className="weq-mf-dress-x"
              title="清空"
              onClick={() => {
                setDraft('');
                setKeyword('');
              }}
            >
              <X size={13} strokeWidth={2} />
            </button>
          ) : null}
        </form>

        {searching && !online ? (
          <div className="weq-mf-mall-empty is-warn">
            <WifiOff size={20} />
            <span>搜索需要登录 QQ 客户端，清空关键词可离线浏览排行。</span>
          </div>
        ) : query.error ? (
          <div className="weq-mf-mall-empty is-warn">
            <WifiOff size={20} />
            <span>{query.error.message}</span>
          </div>
        ) : query.isInitialLoading ? (
          <div className="weq-mf-mall-empty">
            <Loader2 size={18} className="weq-mf-spin" />
            <span>加载中…</span>
          </div>
        ) : items.length === 0 ? (
          <div className="weq-mf-mall-empty">
            <Sparkles size={20} />
            <span>{searching ? '没有匹配的装扮' : '没有结果'}</span>
          </div>
        ) : (
          <div className="weq-mf-mall-grid">
            {items.map((it) => (
              <button
                key={it.itemId}
                type="button"
                className={cn('weq-mf-mall-item', it.itemId === currentId && 'is-current')}
                title={it.name}
                onClick={() => onPick(it)}
              >
                <span className="weq-mf-mall-thumb">
                  {it.previewLargeUrl || it.previewUrl ? (
                    <img
                      src={dressUrl(it.previewLargeUrl || it.previewUrl)}
                      alt={it.name}
                      loading="lazy"
                    />
                  ) : (
                    <span className="weq-mf-mall-noimg">无预览</span>
                  )}
                  {it.itemId === currentId ? (
                    <span className="weq-mf-mall-check">
                      <Check size={12} strokeWidth={3} />
                    </span>
                  ) : null}
                </span>
                <span className="weq-mf-mall-name">{it.name}</span>
                <span className="weq-mf-mall-id">#{it.itemId}</span>
              </button>
            ))}
          </div>
        )}

        {!searching && !query.isInitialLoading && items.length > 0 ? (
          <p className="weq-mf-mall-hint">
            <Trophy size={12} /> 排行榜前 20 名，其他款式可搜索
          </p>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
