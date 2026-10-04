// @ts-nocheck
/**
 * 输入框工具栏「图文 ark」按钮弹出的**通用 Ark 发送框**。
 *
 * 六个 tab，对应六类卡片：
 *   1. 推荐好友     → 服务端取卡（0x12b6_0），发一张可点击的好友卡
 *   2. 推荐群       → 服务端取卡（0x8b7_5），发一张可点击的群卡
 *   3. 群报名       → 服务端下发（0x921b_0），标题 + 详情 + 截止时间 / 报名方式 / 图片
 *   4. 位置卡片     → 搜索 / 地图点选 + 手写地名，走 trpc LocationArk.SsoSendMessage
 *   5. 图文 ark     → 服务端下发（0xdc2_34，与群反馈的 GitHub issue/PR 卡片同一条路）
 *   6. 自定义 JSON  → 自己写一段 ark JSON，原样下发（lightApp 元素）
 *
 * 只做前端：面板不 import 任何 trpc / 协议，收齐输入后交回 `onSend(payload)`，
 * 由 chatPane 补上「发给哪个会话」再交给应用层（与 aiVoicePanel / bounceEmojiPanel 同）。
 * 位置那栏要联网（腾讯位置服务），同样由应用层以 `location` 注入进来，面板不碰网络。
 *
 * 样式全走主题 token（--weq-accent-effective / --weq-fg-* / --popover /
 * --im-color-line），主题色与深浅模式自动跟随，见 styles/ark-panel.css。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { FormEvent, ReactNode, RefObject } from 'react';
import { useOverlayLayer } from '../../lib/overlayStack';
import {
  Braces,
  CalendarClock,
  ClipboardList,
  Image as ImageIcon,
  Link2,
  Loader2,
  MapPin,
  Newspaper,
  RotateCcw,
  Search,
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
  buildGroupSignupArkJson,
  buildLocationArkJson,
  buildTuwenArkJson,
  checkArkJson,
  emptyLinkCardDraft,
  emptySignupDraft,
  isDecimalCoordinate,
  isHttpUrl,
  LINK_CARD_MAX_DESC_CHARS,
  LINK_CARD_MAX_TITLE_CHARS,
  LINK_CARD_MAX_URL_CHARS,
  resolveSignupDeadline,
  resolvedLinkCardIcon,
  SIGNUP_DETAIL_MAX_CHARS,
  SIGNUP_MAX_COUNT_DEFAULT,
  SIGNUP_MAX_COUNT_LIMIT,
  SIGNUP_TITLE_MAX_CHARS,
  type ArkContactEntry,
  type ArkContactSource,
  type ArkLocationProvider,
  type ArkPayload,
  type LinkCardDraft,
  type SignupDraft,
  type SignupMethod,
} from './arkCards';
import { ArkLocationTab, emptyLocationDraft, type ArkLocationDraft } from './arkLocationTab';

type ArkTab = 'friend' | 'group' | 'signup' | 'location' | 'tuwen' | 'json';

const ARK_TABS: Array<{ id: ArkTab; label: string; icon: typeof UserPlus }> = [
  { id: 'friend', label: '好友', icon: UserPlus },
  { id: 'group', label: '群', icon: Users },
  { id: 'signup', label: '报名', icon: ClipboardList },
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
 * 号码输入 + 「从自己的好友 / 群列表里选」的搜索下拉。
 *
 * 两种输入方式并存（都要能用）：
 *   - **手填**：输入框里打出纯数字就立刻算数（与旧面板一致，临时号 / 陌生人也发得出去）；
 *   - **搜索选择**：打昵称 / 备注 / 号码都能过筛，点一行就把号码填进去，并在后面
 *     显示选中的名字（避免「填了个 8 位数，不知道是谁」）。
 *
 * 列表由应用层注入（`contacts`），面板不碰网络。空列表时下拉不给「没有结果」的噪音，
 * 直接回到手填。
 */
function ContactSearch({
  entries,
  icon: Icon,
  placeholder,
  value,
  onChange,
  disabled,
}: {
  entries: readonly ArkContactEntry[];
  icon: typeof UserPlus;
  placeholder: string;
  /** 当前号码（纯数字字符串，空 = 还没填）。 */
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLSpanElement | null>(null);
  /** 下拉挂到 `document.body`，向 overlayStack 领一个盖住面板的层级（见下面 place 注释）。 */
  const layer = useOverlayLayer(open);
  /**
   * 下拉的贴屏坐标。
   *
   * 两条一起用才稳：
   *   - `position: fixed` + `getBoundingClientRect()` 算出来的贴屏坐标；
   *   - 列表本体 `createPortal` 挂到 `document.body`。
   * 不能用 `position: absolute` 贴在字段下面 —— 面板本体是 `overflow: hidden`，输入框
   * 下面紧接着就是卡片预览区，列表会被截在字段那一行里；而只要列表还长在面板里，
   * 任何一层祖先的 `overflow` / `transform` 都可能又把它裁掉。挂到 body 上就彻底
   * 跟裁剪无关了，`fixed` 的坐标才是真正的视口坐标。
   */
  const [anchor, setAnchor] = useState<{
    top: number;
    left: number;
    width: number;
    /** 下方放不下 → 贴到字段上沿（再用 translateY(-100%) 对齐底边）。 */
    flip: boolean;
  } | null>(null);

  const picked = useMemo(
    () => entries.find((entry) => entry.id === value) ?? null,
    [entries, value],
  );

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return entries.slice(0, 8);
    return entries
      .filter(
        (entry) =>
          entry.id.includes(q) ||
          entry.name.toLowerCase().includes(q) ||
          (entry.sub ?? '').toLowerCase().includes(q),
      )
      .slice(0, 8);
  }, [entries, query]);

  useEffect(() => {
    if (!open) {
      setAnchor(null);
      return;
    }
    const place = (): void => {
      const node = inputRef.current;
      if (!node) return;
      const rect = node.getBoundingClientRect();
      // 下面放不下（面板贴着输入框往上长，底下常常只剩预览区的高度）就翻到上面。
      const spaceBelow = window.innerHeight - rect.bottom;
      const flip = spaceBelow < 232 && rect.top > spaceBelow;
      setAnchor({
        top: flip ? rect.top - 4 : rect.bottom + 4,
        left: rect.left,
        width: rect.width,
        flip,
      });
    };
    place();
    window.addEventListener('resize', place);
    // 面板内部滚动 / 窗口滚动都要跟着走（capture 才能听到内层滚动）。
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  function handleType(text: string): void {
    setQuery(text);
    setOpen(true);
    // 纯数字 = 手填号码，直接生效；其余情况先让用户从下拉里选（避免把
    // 「张」这种半截昵称当成号码送出去）。
    if (/^\d+$/.test(text.trim())) onChange(text.trim());
  }

  function pick(entry: ArkContactEntry): void {
    onChange(entry.id);
    setQuery(entry.name);
    setOpen(false);
  }

  function clear(): void {
    onChange('');
    setQuery('');
    setOpen(false);
  }

  return (
    <div className={cn('ark-contact')}>
      <span className={cn('link-card-input')} ref={inputRef}>
        <Icon size={14} strokeWidth={1.9} />
        <input
          type="text"
          value={query}
          placeholder={placeholder}
          spellCheck={false}
          disabled={disabled}
          onChange={(event) => handleType(event.target.value)}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
        />
        {entries.length > 0 ? <Search size={13} strokeWidth={2} aria-hidden /> : null}
        {value || query ? (
          <button
            type="button"
            className={cn('ark-contact-clear')}
            title="清空"
            aria-label="清空"
            onMouseDown={(event) => event.preventDefault()}
            onClick={clear}
          >
            <X size={12} strokeWidth={2.4} />
          </button>
        ) : null}
      </span>

      {picked ? (
        <span className={cn('ark-contact-picked')}>
          {picked.avatarUrl ? (
            <img src={picked.avatarUrl} alt="" loading="lazy" />
          ) : (
            <Icon size={12} strokeWidth={2} />
          )}
          <strong>{picked.name}</strong>
          {picked.sub ? <em>{picked.sub}</em> : null}
        </span>
      ) : null}

      {open && anchor && results.length > 0
        ? createPortal(
            <ul
              className={cn('ark-contact-list')}
              role="listbox"
              style={{
                top: anchor.top,
                left: anchor.left,
                width: anchor.width,
                ...(layer === undefined ? {} : { zIndex: layer }),
                // 翻到上面时用 translateY(-100%) 把列表底边对齐到字段上沿。
                ...(anchor.flip ? { transform: 'translateY(-100%)' } : {}),
              }}
            >
              {results.map((entry) => (
                <li key={entry.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={entry.id === value}
                    className={cn('ark-contact-row', entry.id === value && 'active')}
                    // 按住不让输入框失焦，否则 blur 先把列表收掉、点击落空。
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => pick(entry)}
                  >
                    {entry.avatarUrl ? (
                      <img src={entry.avatarUrl} alt="" loading="lazy" />
                    ) : (
                      <span className={cn('ark-contact-fallback')}>
                        <Icon size={12} strokeWidth={2} />
                      </span>
                    )}
                    <span className={cn('ark-contact-text')}>
                      <strong>{entry.name}</strong>
                      {entry.sub ? <em>{entry.sub}</em> : null}
                    </span>
                  </button>
                </li>
              ))}
            </ul>,
            document.body,
          )
        : null}
    </div>
  );
}

/**
 * 字段容器：label + 内容 + 错误行。
 *
 * 必填只用一个 `*`，不写「必填 / 可选」那两粒字 —— 面板里能省的字全省掉。
 */
/**
 * 位置那栏的紧凑预览 —— 不再重复画一张静态地图卡片。
 *
 * 位置 tab 里已经有一张**可交互**的选点地图（~150px）+ 四个字段，底下再叠一张
 * 静态地图卡预览（~200px）纯属重复，还把面板顶得很高、严重挤压输入区。这里只留
 * 一行摘要（地址 · 省市区），高度约 40px；真要确认整卡效果，预览卡本来就是「就是
 * 对方收到的那张」的参考，位置卡片的渲染在气泡里也能看到。
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

function Field({
  label,
  required,
  error,
  plain,
  children,
}: {
  label: string;
  required?: boolean;
  error?: string | null;
  /**
   * 用 `<div>` 而不是 `<label>` 包裹。
   *
   * 字段默认是 label（点标签能聚焦输入框），但**分段控件 / 单选组里是按钮**：
   * 把按钮塞进 label 会形成非法的嵌套交互元素，点一下就同时「选中该按钮 + 触发 label
   * 行为」。这几栏改用 div，标签只是视觉标签。
   */
  plain?: boolean;
  children: ReactNode;
}) {
  const content = (
    <>
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
    </>
  );
  const className = cn('link-card-field', error && 'is-invalid');
  if (plain) return <div className={className}>{content}</div>;
  return <label className={className}>{content}</label>;
}

export function ArkPanel({
  panelRef,
  disabled,
  disabledHint,
  location,
  contacts,
  defaultSignupGroupCode,
  onSend,
  onClose,
}: {
  panelRef?: RefObject<HTMLDivElement | null>;
  /** QQ 未在线 / 完全离线等：面板照常填，只是发不出去。 */
  disabled: boolean;
  disabledHint: string;
  /** 地点搜索 / 逆地址解析能力；不传则位置那栏只有地图与手填。 */
  location?: ArkLocationProvider;
  /** 好友 / 群候选项（应用层注入）；不传则推荐好友 / 群只能手填号码。 */
  contacts?: ArkContactSource;
  /** 「报名」那栏的默认目标群号（在群聊里打开时预填当前群号）。 */
  defaultSignupGroupCode?: string;
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
  // 群报名
  const [signup, setSignup] = useState<SignupDraft>(() => emptySignupDraft(defaultSignupGroupCode));
  // 位置
  const [locationDraft, setLocationDraft] = useState<ArkLocationDraft>(emptyLocationDraft);
  // 图文 / JSON
  const [tuwen, setTuwen] = useState<LinkCardDraft>(emptyLinkCardDraft);
  const [rawJson, setRawJson] = useState(ARK_JSON_TEMPLATE);

  const friendContactId = parsePositiveInt(friendId);
  const groupContactId = parsePositiveInt(groupId);
  const signupGroupCode = parsePositiveInt(signup.groupCode);
  const signupMaxCount = parsePositiveInt(signup.maxCount);
  const signupDeadline = useMemo(() => resolveSignupDeadline(signup.deadline), [signup.deadline]);
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
    if (tab === 'signup') {
      // 还差点什么就先不画（跟其它栏一致），标题填了就当卡面已有内容。
      if (signupGroupCode === null || !signup.title.trim() || !signup.detail.trim()) return null;
      return buildGroupSignupArkJson(signup);
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
  }, [
    tab,
    friendContactId,
    groupContactId,
    signupGroupCode,
    signup,
    latOk,
    lngOk,
    locationDraft,
    tuwen,
    jsonCheck,
  ]);

  const problems = {
    friend: friendContactId === null ? '需要 QQ 号（纯数字）' : null,
    group: groupContactId === null ? '需要群号（纯数字）' : null,
    signup:
      signupGroupCode === null
        ? '需要群号（纯数字）'
        : !signup.title.trim()
          ? '需要标题'
          : !signup.detail.trim()
            ? '需要详情'
            : signupMaxCount === null
              ? '报名上限需要正整数'
              : signupMaxCount > SIGNUP_MAX_COUNT_LIMIT
                ? `报名上限不能超过 ${SIGNUP_MAX_COUNT_LIMIT}`
                : !signupDeadline.ok
                  ? signupDeadline.error
                  : null,
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
    } else if (tab === 'signup') {
      setSignup(emptySignupDraft(defaultSignupGroupCode));
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
      case 'signup':
        if (signupGroupCode === null || signupMaxCount === null || !signupDeadline.ok) return null;
        // 群报名由服务端按 0x921b_0 的字段生成卡片（面板只把字段交上去）；
        // method=image 时把图片直链带上，服务层会请求一次算 md5 / 宽高。
        return {
          type: 'signup',
          groupCode: signupGroupCode,
          title: signup.title.trim(),
          detail: signup.detail.trim(),
          ...(signupDeadline.seconds !== null ? { deadline: signupDeadline.seconds } : {}),
          method: signup.method === 'image' ? 2 : 1,
          maxCount: signupMaxCount,
          ...(signup.method === 'image' && signup.imageUrl.trim()
            ? { imageUrl: signup.imageUrl.trim() }
            : {}),
        };
      case 'location':
        return {
          type: 'location',
          address: locationDraft.address.trim(),
          region: locationDraft.region.trim(),
          latitude: locationDraft.latitude.trim(),
          longitude: locationDraft.longitude.trim(),
        };
      case 'tuwen':
        // 图文**不再**自己拼 ark JSON 当 lightApp 发（那条路必然失败），改走服务端下发：
        // 与群反馈的 GitHub issue/PR 卡片同一协议（见 MainView → account.sendTuwenArk）。
        // 面板只把四个字段交上去，卡片由服务端生成。
        return {
          type: 'tuwen',
          jumpUrl: tuwen.jumpUrl.trim(),
          title: tuwen.title.trim(),
          desc: tuwen.desc.trim(),
          // 预览图留空时用默认图 —— 服务端会把空值当缺字段，这里先解析好。
          previewUrl: resolvedLinkCardIcon(tuwen),
        };
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
              <ContactSearch
                icon={UserPlus}
                entries={contacts?.friends ?? []}
                value={friendId}
                placeholder="搜索好友，或直接填 QQ 号"
                disabled={sending}
                onChange={setFriendId}
              />
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
            <ContactSearch
              icon={Users}
              entries={contacts?.groups ?? []}
              value={groupId}
              placeholder="搜索群名，或直接填群号"
              disabled={sending}
              onChange={setGroupId}
            />
          </Field>
        ) : null}

        {tab === 'signup' ? (
          <>
            <Field
              label="群号"
              required
              error={touched && signupGroupCode === null ? '需要群号（纯数字）' : null}
            >
              <ContactSearch
                icon={Users}
                entries={contacts?.groups ?? []}
                value={signup.groupCode}
                placeholder="搜索群名，或直接填群号"
                disabled={sending}
                onChange={(next) => setSignup((draft) => ({ ...draft, groupCode: next }))}
              />
            </Field>
            <Field
              label="标题"
              required
              error={touched && !signup.title.trim() ? '标题不能为空' : null}
            >
              <span className={cn('link-card-input')}>
                <input
                  type="text"
                  value={signup.title}
                  maxLength={SIGNUP_TITLE_MAX_CHARS}
                  placeholder="如「周末找搭子」「图片收集」"
                  onChange={(event) =>
                    setSignup((draft) => ({ ...draft, title: event.target.value }))
                  }
                />
                <em className={cn('link-card-count')}>
                  {signup.title.length}/{SIGNUP_TITLE_MAX_CHARS}
                </em>
              </span>
            </Field>
            <Field
              label="详情"
              required
              error={touched && !signup.detail.trim() ? '详情不能为空' : null}
            >
              <textarea
                value={signup.detail}
                rows={3}
                maxLength={SIGNUP_DETAIL_MAX_CHARS}
                placeholder="说明报名须知、时间地点等"
                onChange={(event) =>
                  setSignup((draft) => ({ ...draft, detail: event.target.value }))
                }
              />
            </Field>
            <Field label="报名方式" plain>
              <div className={cn('ark-seg')} role="radiogroup" aria-label="报名方式">
                {(
                  [
                    { id: 'direct', label: '直接报名', caption: '点一下即报名' },
                    { id: 'image', label: '上传图片', caption: '报名时交图' },
                  ] as const
                ).map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    role="radio"
                    aria-checked={signup.method === item.id}
                    className={cn('ark-seg-btn', signup.method === item.id && 'is-active')}
                    onClick={() =>
                      setSignup((draft) => ({ ...draft, method: item.id as SignupMethod }))
                    }
                  >
                    <span className={cn('ark-seg-label')}>{item.label}</span>
                    <span className={cn('ark-seg-caption')}>{item.caption}</span>
                  </button>
                ))}
              </div>
            </Field>
            <div className={cn('ark-grid-2')}>
              <Field
                label="截止时间"
                error={touched && !signupDeadline.ok ? signupDeadline.error : null}
              >
                <span className={cn('link-card-input')}>
                  <CalendarClock size={14} strokeWidth={1.9} />
                  <input
                    type="text"
                    value={signup.deadline}
                    placeholder="留空 = 不截止"
                    spellCheck={false}
                    onChange={(event) =>
                      setSignup((draft) => ({ ...draft, deadline: event.target.value }))
                    }
                  />
                </span>
              </Field>
              <Field
                label="人数上限"
                required
                error={touched && signupMaxCount === null ? '需要正整数' : null}
              >
                <span className={cn('link-card-input')}>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={signup.maxCount}
                    placeholder={String(SIGNUP_MAX_COUNT_DEFAULT)}
                    spellCheck={false}
                    onChange={(event) =>
                      setSignup((draft) => ({
                        ...draft,
                        maxCount: event.target.value.replace(/[^\d]/g, '').slice(0, 3),
                      }))
                    }
                  />
                  <em className={cn('link-card-count')}>人</em>
                </span>
              </Field>
            </div>
            {signup.method === 'image' ? (
              <Field label="图片直链">
                <span className={cn('link-card-input')}>
                  <ImageIcon size={14} strokeWidth={1.9} />
                  <input
                    type="text"
                    value={signup.imageUrl}
                    placeholder="https://…（服务端会取这张图）"
                    spellCheck={false}
                    onChange={(event) =>
                      setSignup((draft) => ({ ...draft, imageUrl: event.target.value }))
                    }
                  />
                </span>
              </Field>
            ) : null}
            {signup.deadline.trim() && signupDeadline.ok ? (
              <p className={cn('ark-locate-note')}>截止：{signupDeadline.label}（东八区）</p>
            ) : null}
          </>
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

      {/* 四种卡片给一张真卡预览（画法与气泡里同一套：QqArk）。位置那栏例外 ——
          它自己就是一张可交互地图，再叠一张静态地图卡预览只会把面板顶高、挤压输入区，
          所以改用一行紧凑摘要（见 LocationPreviewCompact）。 */}
      {tab === 'location' ? (
        <LocationPreviewCompact draft={locationDraft} />
      ) : (
        <ArkPreview arkData={previewArk} />
      )}

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
