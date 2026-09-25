// @ts-nocheck
/**
 * 输入框工具栏「链接」按钮弹出的**链接卡片**面板（QQ 图文 Ark 卡片）。
 *
 * 只做前端：面板把几个输入（跳转链接 / 标题 / 描述 / 图标）拼成一张
 * `com.tencent.tuwen.lua` 的 ark 卡片，编成元素 token 交回给 chatPane 的发送通路
 * （`submitMessage({ extraTokens })`）—— 本模块不碰任何协议，也不负责真正下发。
 *
 * 字段与默认值对齐 SnowLuma 的 `send_tuwen_ark`：
 *   - `summary` 固定 `[分享]`，**不允许输入**，面板里也不展示（它只是卡片自带的一个
 *     固定字段，用户没什么可看的、也没什么可改的）；
 *   - `preview_url`（图标）可留空，默认用 SnowLuma 的默认预览图。
 *
 * 样式全走主题 token（--weq-accent-effective / --weq-fg-* / --popover /
 * --im-color-line），所以主题色与深浅模式自动跟随，见 composer-media.css。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, RefObject } from 'react';
import { Image as ImageIcon, Link2, RotateCcw, SendHorizontal, X } from 'lucide-react';
import { cachedAvatarUrl } from '../../lib/avatarCache';
import { cn } from './classNames';
import { elementToToken } from './draftElements';

/** 摘要固定文案 —— 与 SnowLuma `send_tuwen_ark` 的 summary 默认值一致。 */
export const LINK_CARD_SUMMARY = '[分享]';

/**
 * 默认图标（preview_url）—— 取自 SnowLuma `send_tuwen_ark` 的默认预览图
 * （QQ 自带的一张分享配图），用户留空时用它。
 */
export const LINK_CARD_DEFAULT_ICON =
  'https://tangram-1251316161.file.myqcloud.com/files/20210721/e50a8e37e08f29bf1ffc7466e1950690.png';

/** 卡片在输入框里走的 ark app（图文卡片）。 */
const LINK_CARD_APP = 'com.tencent.tuwen.lua';
/** 卡片模板名（决定 arkData.meta 的形状）。 */
const LINK_CARD_VIEW = 'news';

const MAX_TITLE_CHARS = 80;
const MAX_DESC_CHARS = 200;
const MAX_URL_CHARS = 512;

export type LinkCardDraft = {
  /** 跳转链接（必填，http/https）。 */
  jumpUrl: string;
  /** 标题（必填）。 */
  title: string;
  /** 描述（可选，默认空）。 */
  desc: string;
  /** 图标 / 预览图（可选，留空用 {@link LINK_CARD_DEFAULT_ICON}）。 */
  previewUrl: string;
  /** 摘要：固定 {@link LINK_CARD_SUMMARY}，不可编辑。 */
  summary: string;
};

/** 一张空白卡片草稿（summary 固定，图标留空 = 用默认图）。 */
export function emptyLinkCardDraft(): LinkCardDraft {
  return {
    jumpUrl: '',
    title: '',
    desc: '',
    previewUrl: '',
    summary: LINK_CARD_SUMMARY,
  };
}

/** 留空时回落到默认图标。 */
export function resolvedLinkCardIcon(draft: LinkCardDraft): string {
  return draft.previewUrl.trim() || LINK_CARD_DEFAULT_ICON;
}

/**
 * 草稿 → codec 元素（`kind: 'ark'`，arkData 是一段 JSON 字符串）。
 *
 * arkData 的形状照 `docs/database/nt_msg/elements/ark.md`：顶层 app / view / prompt /
 * meta，内容挂在 `meta.news` 里（渲染器按 app → 布局表读 title/desc/preview/jumpUrl）。
 */
export function linkCardElement(draft: LinkCardDraft): Record<string, unknown> {
  const title = draft.title.trim();
  const desc = draft.desc.trim();
  const icon = resolvedLinkCardIcon(draft);
  const arkData = {
    app: LINK_CARD_APP,
    view: LINK_CARD_VIEW,
    // 会话列表外显文案：QQ 惯例是「[分享] 标题」。
    prompt: `${LINK_CARD_SUMMARY} ${title}`.trim(),
    meta: {
      news: {
        title,
        desc,
        summary: LINK_CARD_SUMMARY,
        jumpUrl: draft.jumpUrl.trim(),
        preview: icon,
        tagIcon: icon,
      },
    },
  };
  return { kind: 'ark', arkData: JSON.stringify(arkData) };
}

/** 草稿 → 元素 token（跟草稿正文同一条通路，chatPane 的 extraTokens 直接吃）。 */
export function linkCardToken(draft: LinkCardDraft): string {
  return elementToToken(linkCardElement(draft));
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\/\S+$/i.test(value.trim());
}

/** 链接展示用的主机名（徽标那行）。取不到就空着。 */
function hostOf(value: string): string {
  try {
    return new URL(value.trim()).host;
  } catch {
    return '';
  }
}

export function LinkCardPanel({
  panelRef,
  disabled,
  disabledHint,
  onSend,
  onClose,
}: {
  panelRef?: RefObject<HTMLDivElement | null>;
  /** QQ 未在线 / 完全离线等：面板照常填，只是发不出去。 */
  disabled: boolean;
  disabledHint: string;
  onSend: (draft: LinkCardDraft) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<LinkCardDraft>(emptyLinkCardDraft);
  const [touched, setTouched] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const firstFieldRef = useRef<HTMLInputElement | null>(null);

  // 一打开就把光标放进第一个输入框，键盘 / 鼠标都不用再点。
  useEffect(() => {
    firstFieldRef.current?.focus({ preventScroll: true });
  }, []);

  function patch<K extends keyof LinkCardDraft>(key: K, value: LinkCardDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  const jumpUrlOk = isHttpUrl(draft.jumpUrl);
  const titleOk = draft.title.trim().length > 0;
  const canSend = jumpUrlOk && titleOk && !disabled;

  const icon = resolvedLinkCardIcon(draft);
  const iconPreview = useMemo(() => cachedAvatarUrl(icon) ?? icon, [icon]);
  const host = hostOf(draft.jumpUrl);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setTouched(true);
    if (!canSend) return;
    onSend({ ...draft, summary: LINK_CARD_SUMMARY });
  }

  return (
    <div
      className={cn('link-card-panel')}
      ref={(node) => {
        rootRef.current = node;
        if (panelRef) panelRef.current = node;
      }}
      role="dialog"
      aria-label="链接卡片"
    >
      <header className={cn('link-card-head')}>
        <span className={cn('link-card-head-title')}>
          <Link2 size={14} strokeWidth={2.1} />
          链接卡片
        </span>
        <button
          type="button"
          className={cn('link-card-close')}
          title="关闭"
          aria-label="关闭"
          onClick={onClose}
        >
          <X size={15} strokeWidth={2.4} />
        </button>
      </header>

      <form className={cn('link-card-body')} onSubmit={handleSubmit}>
        <label className={cn('link-card-field', touched && !jumpUrlOk && 'is-invalid')}>
          <span className={cn('link-card-label')}>
            跳转链接
            <em className={cn('link-card-required')}>必填</em>
          </span>
          <span className={cn('link-card-input')}>
            <Link2 size={14} strokeWidth={1.9} />
            <input
              ref={firstFieldRef}
              type="url"
              value={draft.jumpUrl}
              maxLength={MAX_URL_CHARS}
              placeholder="https://example.com/page"
              spellCheck={false}
              onChange={(event) => patch('jumpUrl', event.target.value)}
            />
          </span>
          {touched && !jumpUrlOk ? (
            <em className={cn('link-card-error')}>请填写 http/https 开头的链接</em>
          ) : null}
        </label>

        <label className={cn('link-card-field', touched && !titleOk && 'is-invalid')}>
          <span className={cn('link-card-label')}>
            标题
            <em className={cn('link-card-required')}>必填</em>
          </span>
          <span className={cn('link-card-input')}>
            <input
              type="text"
              value={draft.title}
              maxLength={MAX_TITLE_CHARS}
              placeholder="点开卡片看到的那行标题"
              onChange={(event) => patch('title', event.target.value)}
            />
            <em className={cn('link-card-count')}>
              {draft.title.length}/{MAX_TITLE_CHARS}
            </em>
          </span>
          {touched && !titleOk ? <em className={cn('link-card-error')}>标题不能为空</em> : null}
        </label>

        <label className={cn('link-card-field')}>
          <span className={cn('link-card-label')}>
            描述
            <em className={cn('link-card-optional')}>可选</em>
          </span>
          <textarea
            value={draft.desc}
            rows={2}
            maxLength={MAX_DESC_CHARS}
            placeholder="留空则不显示描述"
            onChange={(event) => patch('desc', event.target.value)}
          />
        </label>

        <label className={cn('link-card-field')}>
          <span className={cn('link-card-label')}>
            图标
            <em className={cn('link-card-optional')}>可选</em>
          </span>
          <span className={cn('link-card-input')}>
            <ImageIcon size={14} strokeWidth={1.9} />
            <input
              type="url"
              value={draft.previewUrl}
              maxLength={MAX_URL_CHARS}
              placeholder="留空使用默认图标"
              spellCheck={false}
              onChange={(event) => patch('previewUrl', event.target.value)}
            />
          </span>
        </label>

        {/* 预览：跟气泡里 Ark 卡片同一套信息层级（标题 / 描述 / 图标 / 来源行）。 */}
        <div className={cn('link-card-preview')}>
          <span className={cn('link-card-preview-label')}>预览</span>
          <div className={cn('link-card-preview-card')}>
            <div className={cn('link-card-preview-main')}>
              <strong>{draft.title.trim() || '标题'}</strong>
              {draft.desc.trim() ? (
                <p>{draft.desc.trim()}</p>
              ) : (
                <p className={cn('is-placeholder')}>描述（可选）</p>
              )}
              <small>
                <Link2 size={11} strokeWidth={2.2} />
                {host || '跳转链接'}
              </small>
            </div>
            <span className={cn('link-card-preview-thumb')}>
              {icon ? (
                <img
                  src={iconPreview}
                  alt=""
                  loading="lazy"
                  referrerPolicy="no-referrer"
                  onError={(event) => {
                    event.currentTarget.style.visibility = 'hidden';
                  }}
                />
              ) : (
                <ImageIcon size={22} strokeWidth={1.5} />
              )}
            </span>
          </div>
        </div>
      </form>

      <footer className={cn('link-card-foot')}>
        <span className={cn('link-card-hint')}>
          {disabled ? (
            disabledHint
          ) : (
            <>
              <Link2 size={11} strokeWidth={2.2} />
              以图文卡片单独发送，不带输入框里的文字
            </>
          )}
        </span>
        <button
          type="button"
          className={cn('link-card-btn', 'ghost')}
          title="清空重填"
          onClick={() => {
            setDraft(emptyLinkCardDraft());
            setTouched(false);
            firstFieldRef.current?.focus({ preventScroll: true });
          }}
        >
          <RotateCcw size={13} strokeWidth={2.2} />
          重置
        </button>
        <button
          type="button"
          className={cn('link-card-btn', 'primary')}
          title={disabled ? disabledHint : '发送这张链接卡片'}
          disabled={disabled || !jumpUrlOk || !titleOk}
          onClick={() => {
            setTouched(true);
            if (disabled || !jumpUrlOk || !titleOk) return;
            onSend({ ...draft, summary: LINK_CARD_SUMMARY });
          }}
        >
          <SendHorizontal size={13} strokeWidth={2.2} />
          发送
        </button>
      </footer>
    </div>
  );
}
