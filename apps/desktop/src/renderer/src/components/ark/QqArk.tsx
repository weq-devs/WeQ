/**
 * ARK 卡片渲染器（QQ 结构化卡片）。
 *
 * 从「猜布局」升级为「查表渲染」：卡片要显示的内容全在 `arkData.meta` 里，
 * `resolveArkCard`（见 arkCards.ts）按 QQ 官方资源包提取的字段绑定，把 meta 精确
 * 映射成语义槽位值（title/desc/thumb/cover/source/...），再按布局类型分发到少量手调的
 * 布局组件。已知常见卡精确渲染，未知/长尾卡走 generic（带槽位值，仍优于纯猜；再无
 * 槽位则退回启发式，保证不白屏）。
 *
 * 两个特例保留独立分支（不走通用槽位）：
 *   - 群公告 com.tencent.mannounce：title/text 为 base64、无图片素材。
 *   - 位置分享 (lat/lng)：走 QQ 位置服务静态图（见 LocationCard，MAP_KEY 取自 QQ
 *     自己的 com.tencent.map 包），远程图统一走 weq-avatar:// 磁盘缓存。
 */

import { useMemo, type ReactElement, type ReactNode } from 'react';
import { MapPin, Megaphone } from 'lucide-react';
import { cachedAvatarUrl } from '../../lib/avatarCache';
import { resolveArkCard, type ArkValues } from './arkCards';

// ---- types ---------------------------------------------------------------

type ArkPayload = Record<string, unknown>;

interface ArkData {
  app?: string;
  prompt?: string;
  meta?: Record<string, ArkPayload>;
}

// ---- parsing helpers -----------------------------------------------------

function parseArkData(raw: unknown): ArkData | null {
  if (raw && typeof raw === 'object') return raw as ArkData;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    return JSON.parse(raw) as ArkData;
  } catch {
    return null;
  }
}

/** Read a string field off a payload (anything non-string → ''). */
function s(p: ArkPayload, key: string): string {
  const val = p[key];
  return typeof val === 'string' ? val : '';
}

/** Decode a base64 string as UTF-8 (atob yields Latin-1 bytes → TextDecoder). */
function decodeBase64Utf8(raw: string): string {
  try {
    const bytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return raw;
  }
}

/** 远程图片统一过 weq-avatar:// 磁盘缓存（满足 renderer CSP、避免重复回源）。 */
function arkImg(src?: string | null): string | undefined {
  if (!src) return undefined;
  return cachedAvatarUrl(src) ?? src;
}

/** 点击整卡打开链接：仅开 http(s)（忽略 mqqapi 等内部协议）。 */
function openHandler(jump?: string): (() => void) | undefined {
  const ok = !!jump && jump !== '#' && /^https?:\/\//i.test(jump);
  if (!ok) return undefined;
  return () => window.open(jump, '_blank');
}

// ---- shared shell --------------------------------------------------------

function ArkShell({
  jump,
  className,
  children,
  footer,
}: {
  jump?: string;
  className?: string;
  children: ReactNode;
  footer?: ReactNode;
}): ReactElement {
  const onOpen = openHandler(jump);
  return (
    <div
      className={className ? `weq-ark-container ${className}` : 'weq-ark-container'}
      role={onOpen ? 'link' : undefined}
      title={onOpen ? jump : undefined}
      onClick={onOpen}
    >
      <div className="weq-ark-content">{children}</div>
      {footer}
    </div>
  );
}

function ArkFooter({ source, icon }: { source?: string; icon?: string }): ReactElement | null {
  if (!source && !icon) return null;
  return (
    <div className="weq-ark-footer">
      {icon ? <img className="weq-ark-footer-icon" src={arkImg(icon)} alt="" loading="lazy" /> : null}
      <span>{source}</span>
    </div>
  );
}

// ---- layout components ----------------------------------------------------

/** 名片：左头像 + 右昵称/副标题，底部来源标签（contact / cardshare / 名片分享变体）。 */
function ContactCard({ v }: { v: ArkValues }): ReactElement {
  return (
    <ArkShell jump={v.jump} className="weq-ark-contact" footer={<ArkFooter source={v.footerSource} icon={v.footerIcon} />}>
      <div className="weq-ark-contact-body">
        {v.avatar ? <img className="weq-ark-contact-avatar" src={arkImg(v.avatar)} alt="" loading="lazy" /> : null}
        <div className="weq-ark-contact-main">
          <div className="weq-ark-contact-name">{v.name || v.title || v.source || '推荐名片'}</div>
          {v.desc || v.summary ? <div className="weq-ark-contact-sub">{v.desc || v.summary}</div> : null}
        </div>
      </div>
    </ArkShell>
  );
}

/** 图文：标题在上，描述在左、缩略图在右，底部来源（图文/音乐/视频/结构化消息分享）。 */
function NewsCard({ v }: { v: ArkValues }): ReactElement {
  const thumb = v.thumb || v.cover;
  return (
    <ArkShell jump={v.jump} footer={<ArkFooter source={v.source} icon={v.sourceIcon} />}>
      {v.title ? <div className="weq-ark-title">{v.title}</div> : null}
      <div className="weq-ark-body-compact">
        <div className="weq-ark-desc">{v.desc || v.summary || ''}</div>
        {thumb ? <img className="weq-ark-preview-small" src={arkImg(thumb)} alt="" loading="lazy" /> : null}
      </div>
    </ArkShell>
  );
}

/** 应用块：顶部来源头（icon+名）/ 标题 / 通栏大图 / 底部来源（小程序）。 */
function AppBlockCard({ v }: { v: ArkValues }): ReactElement {
  const big = v.cover || v.thumb;
  const headerShown = !!v.source;
  // 顶部没来源文字时，把来源降级到底部展示，避免头部空白。
  const footerSource = v.footerSource || (headerShown ? '' : v.source);
  const footerIcon = v.footerIcon || (headerShown ? '' : v.sourceIcon);
  return (
    <ArkShell jump={v.jump} footer={<ArkFooter source={footerSource} icon={footerIcon} />}>
      {headerShown ? (
        <div className="weq-ark-header">
          {v.sourceIcon ? <img className="weq-ark-icon-app" src={arkImg(v.sourceIcon)} alt="" loading="lazy" /> : null}
          <span>{v.source}</span>
        </div>
      ) : null}
      {v.title ? <div className="weq-ark-title">{v.title}</div> : null}
      {v.desc ? (
        <div className="weq-ark-desc" style={{ marginBottom: big ? 8 : 0 }}>
          {v.desc}
        </div>
      ) : null}
      {big ? <img className="weq-ark-preview-big" src={arkImg(big)} alt="" loading="lazy" /> : null}
    </ArkShell>
  );
}

/** 媒体块：主文案 / 通栏封面 / 动作按钮 / 底部来源（一起听、一起看等）。 */
function MediaBlockCard({ v }: { v: ArkValues }): ReactElement {
  const big = v.cover || v.thumb;
  return (
    <ArkShell jump={v.jump} footer={<ArkFooter source={v.footerSource || v.source} icon={v.footerIcon || v.sourceIcon} />}>
      {v.summary || v.desc || v.title ? <div className="weq-ark-title">{v.summary || v.desc || v.title}</div> : null}
      {big ? <img className="weq-ark-preview-big" src={arkImg(big)} alt="" loading="lazy" /> : null}
      {v.button ? <div className="weq-ark-action-btn">{v.button}</div> : null}
    </ArkShell>
  );
}

/**
 * 通用卡：布局命不中具体类型时用。
 * ① 有槽位值 → 按大图/小图自动排版；② 无槽位值 → 退回启发式（保证不白屏）。
 */
function GenericCard({
  values,
  payload,
  prompt,
}: {
  values: ArkValues | null;
  payload: ArkPayload;
  prompt: string;
}): ReactElement {
  const hasSlots =
    !!values && !!(values.title || values.desc || values.summary || values.thumb || values.cover || values.name);
  if (values && hasSlots) {
    const small = values.thumb;
    const big = values.cover;
    return (
      <ArkShell jump={values.jump} footer={<ArkFooter source={values.source} icon={values.sourceIcon} />}>
        {values.title || values.name ? <div className="weq-ark-title">{values.title || values.name}</div> : null}
        {small ? (
          <div className="weq-ark-body-compact">
            <div className="weq-ark-desc">{values.desc || values.summary || ''}</div>
            <img className="weq-ark-preview-small" src={arkImg(small)} alt="" loading="lazy" />
          </div>
        ) : (
          <>
            {values.desc || values.summary ? (
              <div className="weq-ark-desc" style={{ marginBottom: big ? 8 : 0 }}>
                {values.desc || values.summary}
              </div>
            ) : null}
            {big ? <img className="weq-ark-preview-big" src={arkImg(big)} alt="" loading="lazy" /> : null}
          </>
        )}
        {values.button ? <div className="weq-ark-action-btn">{values.button}</div> : null}
      </ArkShell>
    );
  }
  return <HeuristicCard p={payload} prompt={prompt} />;
}

// ---- 群公告 (com.tencent.mannounce) --------------------------------------

/**
 * 群公告卡。payload 里 title/text 为 base64 (encode=1)、无图片素材，不复用通用引擎。
 * title 实为头部标签（如「群公告」），text 才是正文（保留换行）。卡片不可点击。
 */
function ArkGroupAnnounce({ p }: { p: ArkPayload }): ReactElement {
  const encoded = p.encode === 1 || p.encode === '1';
  const decode = (raw: string): string => (encoded ? decodeBase64Utf8(raw) : raw);
  const title = decode(s(p, 'title')).trim() || '群公告';
  const text = decode(s(p, 'text')).trim();
  return (
    <div className="weq-ark-container weq-ark-announce">
      <div className="weq-ark-content">
        <div className="weq-ark-header">
          <Megaphone className="weq-ark-announce-icon" size={14} strokeWidth={2.2} />
          <span>{title}</span>
        </div>
        {text ? <div className="weq-ark-announce-text">{text}</div> : null}
      </div>
    </div>
  );
}

// ---- 位置分享 (QQ 位置服务静态图) ----------------------------------------

/**
 * MAP_KEY 取自 QQ 自己的 com.tencent.map ark 包，对同一 staticmap/v2 端点画缩略图，
 * 像素级一致。共享 key：本地渲染够用，大流量公用可能被限速。
 */
const QQ_MAP_KEY = 'RJNBZ-56724-USWUA-XVB56-RWETV-AIBPS';

function qqStaticMapUrl(lat: string, lng: string): string {
  const q = new URLSearchParams({
    key: QQ_MAP_KEY,
    size: '280*130',
    center: `${lat},${lng}`,
    zoom: '16',
    format: 'png8',
    no_logo: '1',
    scale: '2',
  });
  return `https://apis.map.qq.com/ws/staticmap/v2/?${q.toString()}`;
}

function ArkLocation({
  lat,
  lng,
  name,
  address,
  jump,
}: {
  lat: string;
  lng: string;
  name: string;
  address: string;
  jump?: string;
}): ReactElement {
  const mapSrc = lat && lng ? cachedAvatarUrl(qqStaticMapUrl(lat, lng)) : null;
  const onOpen = openHandler(jump);
  return (
    <div
      className="weq-ark-container"
      role={onOpen ? 'link' : undefined}
      title={onOpen ? jump : undefined}
      onClick={onOpen}
    >
      <div className="weq-ark-content">
        {name ? <div className="weq-ark-title">{name}</div> : null}
        {address ? <div className="weq-ark-desc" style={{ color: '#8c8c8c', marginBottom: 8 }}>{address}</div> : null}
        <div className="weq-ark-map-view">
          {mapSrc ? (
            <img
              className="weq-ark-map-img"
              src={mapSrc}
              alt=""
              loading="lazy"
              onError={(e) => {
                e.currentTarget.style.display = 'none';
              }}
            />
          ) : null}
          <MapPin className="weq-ark-map-pin" size={28} strokeWidth={2.2} />
          {name ? <span className="weq-ark-map-name">{name}</span> : null}
        </div>
      </div>
    </div>
  );
}

// ---- 启发式兜底引擎（原通用引擎，未知卡最后的防线，保证不白屏） ------------

function HeuristicCard({ p, prompt }: { p: ArkPayload; prompt: string }): ReactElement {
  const appIcon = s(p, 'icon') || null;
  const footerIcon = s(p, 'tagIcon') || null;
  const mainImg = s(p, 'preview') || s(p, 'cover') || s(p, 'avatar') || null;
  const actionBtnText = s(p, 'button') || null;
  const jumpUrl = s(p, 'jumpUrl') || s(p, 'qqdocurl') || s(p, 'url') || '#';

  let header = '';
  let title = s(p, 'title') || s(p, 'summary') || s(p, 'nickname') || prompt || '';
  let desc = s(p, 'desc') || s(p, 'contact') || s(p, 'address') || '';
  if (appIcon || p.appid) {
    header = s(p, 'title');
    title = s(p, 'desc');
    desc = s(p, 'summary');
  } else if (s(p, 'nickname')) {
    header = s(p, 'tag') || '推荐联系人';
  }
  if (s(p, 'title') && s(p, 'summary') && s(p, 'title').includes('听歌')) {
    title = s(p, 'summary');
    desc = s(p, 'title');
  }

  const isBlockLayout = !!(s(p, 'cover') || (appIcon && s(p, 'preview')) || actionBtnText);
  const isCompactLayout = !!(mainImg && !isBlockLayout);

  let footerLabel = s(p, 'tag') || '';
  if (!footerLabel && prompt) {
    footerLabel = prompt.match(/^\[(.*?)\]/)?.[1] ?? '应用分享';
  }

  return (
    <ArkShell
      jump={jumpUrl}
      footer={<ArkFooter source={footerLabel} icon={footerIcon ?? undefined} />}
    >
      {header || appIcon ? (
        <div className="weq-ark-header">
          {appIcon ? <img className="weq-ark-icon-app" src={arkImg(appIcon)} alt="" loading="lazy" /> : null}
          <span>{header}</span>
        </div>
      ) : null}
      {title ? <div className="weq-ark-title">{title}</div> : null}
      {isCompactLayout ? (
        <div className="weq-ark-body-compact">
          <div className="weq-ark-desc">{desc}</div>
          {mainImg ? <img className="weq-ark-preview-small" src={arkImg(mainImg)} alt="" loading="lazy" /> : null}
        </div>
      ) : (
        <>
          {desc ? (
            <div className="weq-ark-desc" style={{ marginBottom: 8 }}>
              {desc}
            </div>
          ) : null}
          {isBlockLayout && mainImg ? (
            <img className="weq-ark-preview-big" src={arkImg(mainImg)} alt="" loading="lazy" />
          ) : null}
        </>
      )}
      {actionBtnText ? <div className="weq-ark-action-btn">{actionBtnText}</div> : null}
    </ArkShell>
  );
}

// ---- entry ---------------------------------------------------------------

export function QqArk({ arkData }: { arkData: unknown }): ReactElement | null {
  const data = useMemo(() => parseArkData(arkData), [arkData]);

  const firstKey = data?.meta ? Object.keys(data.meta)[0] : undefined;
  const p: ArkPayload | null = data?.meta && firstKey ? data.meta[firstKey] ?? null : null;
  if (!data || !p) return null;

  const app = typeof data.app === 'string' ? data.app : '';
  const prompt = typeof data.prompt === 'string' ? data.prompt : '';

  // 特例1：群公告。
  if (app === 'com.tencent.mannounce') return <ArkGroupAnnounce p={p} />;

  // 特例2：位置分享（任何带 lat/lng 的卡都走静态地图）。
  const lat = s(p, 'lat');
  const lng = s(p, 'lng');
  if (lat && lng) {
    return (
      <ArkLocation
        lat={lat}
        lng={lng}
        name={s(p, 'name')}
        address={s(p, 'address') || s(p, 'desc')}
        jump={s(p, 'jumpUrl') || s(p, 'qqdocurl') || s(p, 'url') || undefined}
      />
    );
  }

  const { layout, values } = resolveArkCard(app, data.meta ?? {});
  switch (layout) {
    case 'contact':
      return <ContactCard v={values!} />;
    case 'news':
      return <NewsCard v={values!} />;
    case 'appBlock':
      return <AppBlockCard v={values!} />;
    case 'mediaBlock':
      return <MediaBlockCard v={values!} />;
    default:
      return <GenericCard values={values} payload={p} prompt={prompt} />;
  }
}
