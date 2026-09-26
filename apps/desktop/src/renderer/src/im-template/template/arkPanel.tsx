// @ts-nocheck
/**
 * 输入框工具栏「图文 ark」按钮弹出的**通用 Ark 发送框**。
 *
 * 五个 tab，对应五种卡片：
 *   1. 推荐好友     → 服务端取卡（0x12b6_0），发一张可点击的好友卡
 *   2. 推荐群       → 服务端取卡（0x8b7_5），发一张可点击的群卡
 *   3. 位置卡片     → 搜索 / 地图点选 + 手写地名，走 trpc LocationArk.SsoSendMessage
 *   4. 图文 ark     → 表单拼 `com.tencent.tuwen.lua` 的 news 卡（与旧面板一致）
 *   5. 自定义 JSON  → 自己写一段 ark JSON，原样下发
 *
 * 只做前端：面板不 import 任何 trpc / 协议，收齐输入后交回 `onSend(payload)`，
 * 由 chatPane 补上「发给哪个会话」再交给应用层（与 aiVoicePanel / bounceEmojiPanel 同）。
 * 位置那栏要联网（腾讯位置服务），同样由应用层以 `location` 注入进来，面板不碰网络。
 *
 * 样式全走主题 token（--weq-accent-effective / --weq-fg-* / --popover /
 * --im-color-line），主题色与深浅模式自动跟随，见 styles/ark-panel.css。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, ReactNode, RefObject } from 'react';
import {
  Braces,
  Image as ImageIcon,
  Link2,
  Loader2,
  MapPin,
  Newspaper,
  RotateCcw,
  SendHorizontal,
  Sparkles,
  UserPlus,
  Users,
  Wand2,
  X,
} from 'lucide-react';
import { cn } from './classNames';
import { QqArk } from '../../components/ark/QqArk';
import {
  ARK_JSON_TEMPLATE,
  buildContactPlaceholderArk,
  buildLocationArkJson,
  buildTuwenArkJson,
  checkArkJson,
  emptyLinkCardDraft,
  isDecimalCoordinate,
  isHttpUrl,
  LINK_CARD_MAX_DESC_CHARS,
  LINK_CARD_MAX_TITLE_CHARS,
  LINK_CARD_MAX_URL_CHARS,
  type ArkLocationProvider,
  type ArkPayload,
  type LinkCardDraft,
} from './arkCards';
import { ArkLocationTab, emptyLocationDraft, type ArkLocationDraft } from './arkLocationTab';

type ArkTab = 'friend' | 'group' | 'location' | 'tuwen' | 'json';

const ARK_TABS: Array<{ id: ArkTab; label: string; icon: typeof UserPlus }> = [
  { id: 'friend', label: '好友', icon: UserPlus },
  { id: 'group', label: '群', icon: Users },
  { id: 'location', label: '位置', icon: MapPin },
  { id: 'tuwen', label: '图文', icon: Newspaper },
  { id: 'json', label: 'JSON', icon: Braces },
];

/** 纯数字 QQ 号 / 群号校验（正整数）。 */
function parsePositiveInt(value: string): number | null {
  const text = value.trim();
  if (!/^\d+$/.test(text)) return null;
  const num = Number(text);
  return Number.isSafeInteger(num) && num > 0 ? num : null;
}

/**
 * 预览能不能画：`QqArk` 只认「合法 JSON 且带 meta」的卡片，其余它返回 null。
 */
function previewableArk(arkData: string | null): string | null {
  if (!arkData) return null;
  const check = checkArkJson(arkData);
  if (!check.ok) return null;
  try {
    const parsed = JSON.parse(check.pretty) as { meta?: unknown };
    const meta = parsed?.meta;
    return meta && typeof meta === 'object' && Object.keys(meta).length > 0 ? check.pretty : null;
  } catch {
    return null;
  }
}

/**
 * 卡片预览 —— **直接调渲染器本体**（`QqArk`）画，所以在面板里看到的就是对方收到的那张，
 * 不存在「预览与实际不一致」这回事。
 *
 * 整块禁用指针事件：预览是给你看样子的，别一个误点就把卡片的跳转开出去了。
 */
function ArkPreview({ arkData }: { arkData: string | null }) {
  const preview = previewableArk(arkData);
  return (
    <div className={cn('ark-preview')} aria-live="polite">
      {preview ? (
        <div className={cn('ark-preview-stage')}>
          <QqArk arkData={preview} />
        </div>
      ) : (
        <div className={cn('ark-preview-empty')} aria-hidden>
          <Sparkles size={16} strokeWidth={1.7} />
        </div>
      )}
    </div>
  );
}

/**
 * 字段容器：label + 内容 + 错误行。
 *
 * 必填只用一个 `*`，不写「必填 / 可选」那两粒字 —— 面板里能省的字全省掉。
 */
function Field({
  label,
  required,
  error,
  children,
}: {
  label: string;
  required?: boolean;
  error?: string | null;
  children: ReactNode;
}) {
  return (
    <label className={cn('link-card-field', error && 'is-invalid')}>
      <span className={cn('link-card-label')}>
        {label}
        {required ? (
          <em className={cn('ark-req')} title="必填">
            *
          </em>
        ) : null}
      </span>
      {children}
      {error ? <em className={cn('link-card-error')}>{error}</em> : null}
    </label>
  );
}

export function ArkPanel({
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
  /** 地点搜索 / 逆地址解析能力；不传则位置那栏只有地图与手填。 */
  location?: ArkLocationProvider;
  /** 交回应用层发送；**抛出即失败**，面板保留已填内容并显示原因。 */
  onSend: (payload: ArkPayload) => Promise<void>;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<ArkTab>('friend');
  const [touched, setTouched] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // 好友 / 群
  const [friendId, setFriendId] = useState('');
  const [friendPhone, setFriendPhone] = useState('');
  const [groupId, setGroupId] = useState('');
  // 位置
  const [locationDraft, setLocationDraft] = useState<ArkLocationDraft>(emptyLocationDraft);
  // 图文 / JSON
  const [tuwen, setTuwen] = useState<LinkCardDraft>(emptyLinkCardDraft);
  const [rawJson, setRawJson] = useState(ARK_JSON_TEMPLATE);

  const friendContactId = parsePositiveInt(friendId);
  const groupContactId = parsePositiveInt(groupId);
  const latOk = isDecimalCoordinate(locationDraft.latitude, 90);
  const lngOk = isDecimalCoordinate(locationDraft.longitude, 180);
  const jsonCheck = useMemo(() => checkArkJson(rawJson), [rawJson]);

  /**
   * 预览用的 ark JSON —— 五种卡片各给了「现在就发」那把输入对应的那份：
   * 图文 / 自定义 JSON 就是即将发出去的那段 JSON，推荐好友 / 群与位置卡片也是发送时
   * 用的那一份（前者是本地占位卡，后者与乐观卡片同一份）。还拼不出卡时给 null，
   * 预览位显示空态（不会一敲字就抽得整个面板跳一下）。
   */
  const previewArk = useMemo<string | null>(() => {
    if (tab === 'friend') {
      return friendContactId === null ? null : buildContactPlaceholderArk('qq', friendContactId);
    }
    if (tab === 'group') {
      return groupContactId === null ? null : buildContactPlaceholderArk('group', groupContactId);
    }
    if (tab === 'location') {
      const hasSpot = latOk && lngOk;
      return hasSpot || locationDraft.address.trim() || locationDraft.region.trim()
        ? buildLocationArkJson(locationDraft)
        : null;
    }
    if (tab === 'tuwen') {
      return tuwen.title.trim() || tuwen.jumpUrl.trim() ? buildTuwenArkJson(tuwen) : null;
    }
    return jsonCheck.ok ? jsonCheck.pretty : null;
  }, [tab, friendContactId, groupContactId, latOk, lngOk, locationDraft, tuwen, jsonCheck]);

  const problems = {
    friend: friendContactId === null ? '需要 QQ 号（纯数字）' : null,
    group: groupContactId === null ? '需要群号（纯数字）' : null,
    location: !locationDraft.address.trim()
      ? '需要地址'
      : !locationDraft.region.trim()
        ? '需要省市区'
        : !latOk || !lngOk
          ? '需要在地图上点选位置（或填合法经纬度）'
          : null,
    tuwen: !isHttpUrl(tuwen.jumpUrl)
      ? '链接需要 http/https 开头'
      : !tuwen.title.trim()
        ? '需要标题'
        : null,
    json: jsonCheck.ok ? null : jsonCheck.error,
  } satisfies Record<ArkTab, string | null>;

  const currentProblem = problems[tab];
  const canSend = !disabled && !sending && currentProblem === null;

  // 切 tab 就把上一条错误收掉（它属于上一次尝试）。
  useEffect(() => {
    setError(null);
  }, [tab]);

  function resetCurrent(): void {
    setTouched(false);
    setError(null);
    if (tab === 'friend') {
      setFriendId('');
      setFriendPhone('');
    } else if (tab === 'group') {
      setGroupId('');
    } else if (tab === 'location') {
      setLocationDraft(emptyLocationDraft());
    } else if (tab === 'tuwen') {
      setTuwen(emptyLinkCardDraft());
    } else {
      setRawJson(ARK_JSON_TEMPLATE);
    }
  }

  function buildPayload(): ArkPayload | null {
    switch (tab) {
      case 'friend':
        return friendContactId === null
          ? null
          : {
              type: 'contact',
              kind: 'qq',
              contactId: friendContactId,
              ...(friendPhone.trim() ? { phoneNumber: friendPhone.trim() } : {}),
            };
      case 'group':
        return groupContactId === null
          ? null
          : { type: 'contact', kind: 'group', contactId: groupContactId };
      case 'location':
        return {
          type: 'location',
          address: locationDraft.address.trim(),
          region: locationDraft.region.trim(),
          latitude: locationDraft.latitude.trim(),
          longitude: locationDraft.longitude.trim(),
        };
      case 'tuwen':
        return { type: 'ark', arkData: buildTuwenArkJson(tuwen) };
      case 'json':
        return jsonCheck.ok ? { type: 'ark', arkData: jsonCheck.pretty } : null;
      default:
        return null;
    }
  }

  async function submit(): Promise<void> {
    setTouched(true);
    if (!canSend) return;
    const payload = buildPayload();
    if (!payload) return;
    setSending(true);
    setError(null);
    try {
      await onSend(payload);
    } catch (err) {
      // 失败不吞内容：错误显示在底栏，用户改一改就能重发。
      setError(err instanceof Error ? err.message : String(err));
      setSending(false);
      return;
    }
    setSending(false);
  }

  function handleFormSubmit(event: FormEvent): void {
    event.preventDefault();
    void submit();
  }

  // 底栏只在「有话说」时才占位：发送中 / 出错 / 还差点什么，其余时候留空。
  // 未碰过的表单不预先报警告 —— 那是文字噪音。
  const shownProblem = touched ? currentProblem : null;
  const hint = disabled ? disabledHint : sending ? '发送中…' : (error ?? shownProblem);

  return (
    <div
      className={cn('ark-panel')}
      ref={(node) => {
        rootRef.current = node;
        if (panelRef) panelRef.current = node;
      }}
      role="dialog"
      aria-label="发送 Ark 卡片"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      {/* 没有标题栏：一行 tab 就是全部头部（图标 + 两三个字的标签），关闭按钮贴在行尾。
          面板本来就不高，少一行就少 38px，也少一堆字。 */}
      <nav className={cn('ark-tabs')} role="tablist">
        {ARK_TABS.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              className={cn('ark-tab', tab === item.id && 'active')}
              onClick={() => setTab(item.id)}
            >
              <Icon size={13} strokeWidth={2.1} />
              {item.label}
            </button>
          );
        })}
        <button
          type="button"
          className={cn('ark-close')}
          title="关闭"
          aria-label="关闭"
          onClick={onClose}
        >
          <X size={14} strokeWidth={2.4} />
        </button>
      </nav>

      <form className={cn('ark-body')} onSubmit={handleFormSubmit}>
        {tab === 'friend' ? (
          <>
            <Field
              label="QQ 号"
              required
              error={touched && problems.friend ? problems.friend : null}
            >
              <span className={cn('link-card-input')}>
                <UserPlus size={14} strokeWidth={1.9} />
                <input
                  type="text"
                  inputMode="numeric"
                  value={friendId}
                  placeholder="被推荐的好友"
                  spellCheck={false}
                  onChange={(event) => setFriendId(event.target.value)}
                />
              </span>
            </Field>
            <Field label="手机号">
              <span className={cn('link-card-input')}>
                <input
                  type="text"
                  inputMode="tel"
                  value={friendPhone}
                  placeholder="可留空"
                  spellCheck={false}
                  onChange={(event) => setFriendPhone(event.target.value)}
                />
              </span>
            </Field>
          </>
        ) : null}

        {tab === 'group' ? (
          <Field label="群号" required error={touched && problems.group ? problems.group : null}>
            <span className={cn('link-card-input')}>
              <Users size={14} strokeWidth={1.9} />
              <input
                type="text"
                inputMode="numeric"
                value={groupId}
                placeholder="被推荐的群"
                spellCheck={false}
                onChange={(event) => setGroupId(event.target.value)}
              />
            </span>
          </Field>
        ) : null}

        {tab === 'location' ? (
          <ArkLocationTab
            value={locationDraft}
            onChange={(patch) => setLocationDraft((current) => ({ ...current, ...patch }))}
            provider={location}
            disabled={sending}
          />
        ) : null}

        {tab === 'tuwen' ? (
          <>
            <Field
              label="链接"
              required
              error={touched && !isHttpUrl(tuwen.jumpUrl) ? '请填写 http/https 开头的链接' : null}
            >
              <span className={cn('link-card-input')}>
                <Link2 size={14} strokeWidth={1.9} />
                <input
                  type="text"
                  value={tuwen.jumpUrl}
                  maxLength={LINK_CARD_MAX_URL_CHARS}
                  placeholder="https://example.com/page"
                  spellCheck={false}
                  onChange={(event) => setTuwen({ ...tuwen, jumpUrl: event.target.value })}
                />
              </span>
            </Field>
            <Field
              label="标题"
              required
              error={touched && !tuwen.title.trim() ? '标题不能为空' : null}
            >
              <span className={cn('link-card-input')}>
                <input
                  type="text"
                  value={tuwen.title}
                  maxLength={LINK_CARD_MAX_TITLE_CHARS}
                  placeholder="标题"
                  onChange={(event) => setTuwen({ ...tuwen, title: event.target.value })}
                />
                <em className={cn('link-card-count')}>
                  {tuwen.title.length}/{LINK_CARD_MAX_TITLE_CHARS}
                </em>
              </span>
            </Field>
            <Field label="描述">
              <textarea
                value={tuwen.desc}
                rows={2}
                maxLength={LINK_CARD_MAX_DESC_CHARS}
                placeholder="描述（可选）"
                onChange={(event) => setTuwen({ ...tuwen, desc: event.target.value })}
              />
            </Field>
            <Field label="图标">
              <span className={cn('link-card-input')}>
                <ImageIcon size={14} strokeWidth={1.9} />
                <input
                  type="text"
                  value={tuwen.previewUrl}
                  maxLength={LINK_CARD_MAX_URL_CHARS}
                  placeholder="图标 URL（留空用默认）"
                  spellCheck={false}
                  onChange={(event) => setTuwen({ ...tuwen, previewUrl: event.target.value })}
                />
              </span>
            </Field>
          </>
        ) : null}

        {tab === 'json' ? (
          <>
            <Field label="JSON" required error={touched && !jsonCheck.ok ? jsonCheck.error : null}>
              <textarea
                className={cn('ark-json')}
                value={rawJson}
                rows={8}
                spellCheck={false}
                placeholder='{ "app": "…", "view": "…" }'
                onChange={(event) => setRawJson(event.target.value)}
              />
            </Field>
            <div className={cn('ark-json-tools')}>
              <button
                type="button"
                className={cn('link-card-btn', 'ghost')}
                disabled={!jsonCheck.ok}
                title="格式化"
                onClick={() => {
                  if (jsonCheck.ok) setRawJson(jsonCheck.pretty);
                }}
              >
                <Wand2 size={13} strokeWidth={2.2} />
              </button>
              <span
                className={cn('ark-json-state', jsonCheck.ok ? 'is-ok' : 'is-bad')}
                title={jsonCheck.ok ? 'JSON 合法' : (jsonCheck.error ?? '')}
              />
            </div>
          </>
        ) : null}
      </form>

      {/* 五种卡片都给一张真卡预览（画法与气泡里同一套：QqArk）。 */}
      <ArkPreview arkData={previewArk} />

      <footer className={cn('ark-foot')}>
        <span className={cn('ark-foot-hint', (error || shownProblem) && 'is-error')}>
          {sending ? <Loader2 size={11} strokeWidth={2.4} className="ark-spin" /> : null}
          {hint}
        </span>
        <button
          type="button"
          className={cn('link-card-btn', 'ghost')}
          title="清空重填"
          onClick={resetCurrent}
        >
          <RotateCcw size={13} strokeWidth={2.2} />
        </button>
        <button
          type="button"
          className={cn('link-card-btn', 'primary')}
          title={disabled ? disabledHint : '发送这张卡片'}
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
