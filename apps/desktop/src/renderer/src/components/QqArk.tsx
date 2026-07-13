/**
 * Renders an `ark` element (QQ 结构化卡片) as a card, faithfully porting the
 * "Ark Ultimate Robust Engine" demo (renderUniversalArk). One universal engine
 * decides the layout purely from the payload's feature fields — no per-type
 * enumeration — so every share kind in the demo draws from the same code path:
 *
 *   1. 图文分享 (tuwen news, preview)        → 左右紧凑型 (desc + small thumb)
 *   2. 地图分享 (Location.Search, lat/lng)   → 通栏地图 (address + map)
 *   3. QQ小程序 (miniapp_01, icon+preview)   → 应用头 + 通栏大图
 *   4. 一起听歌 (together, cover+button)      → 通栏大图 + 动作按钮 (文案倒置)
 *   5. 推荐联系人名片 (contact, avatar)        → 紧凑头像名片
 *   6. QQ收藏 (tuwen news, tag/tagIcon)       → 紧凑图文 + 小尾巴
 *   7. 群名片 (contact, qun.share)            → 紧凑头像名片
 *
 * The element only carries the raw `arkData` JSON string (see RenderArkElement
 * in service/msg_view.ts); we parse it here. Remote images are funnelled through
 * the `weq-avatar://` disk cache (cachedAvatarUrl) so they survive the renderer
 * CSP and don't re-hit the CDN on every render.
 *
 * The map (Location.Search) used to be the one piece we couldn't render: the
 * demo's Leaflet widget pulls OSM tiles straight from the browser (blocked by
 * the renderer CSP), and proxying OSM tiles server-side gets HTTP 418 "access
 * blocked". The fix is to skip tiles entirely and use QQ 位置服务's static-map
 * endpoint (`apis.map.qq.com/ws/staticmap/v2`) — one PNG per location, keyed
 * with the MAP_KEY baked into QQ's own `com.tencent.map` ark package. That URL
 * serves fine to a server-side fetch (empty Referer, non-browser UA), so it
 * rides the existing `weq-avatar://` disk cache like any other remote image.
 * The QQ share coordinate is GCJ-02, matching QQ's own tiles, so no conversion.
 * If the image ever fails to load we fall back to the CSS faux-map backdrop
 * (still behind the pin), and the address is shown above the map regardless.
 */

import { useMemo, type ReactElement } from 'react';
import { MapPin, Megaphone } from 'lucide-react';
import { cachedAvatarUrl } from '../lib/avatarCache';

// ---- types ---------------------------------------------------------------

/** The decoded ark payload — the first (and only) value under `meta`. */
type ArkPayload = Record<string, unknown>;

interface ArkData {
  app?: string;
  prompt?: string;
  meta?: Record<string, ArkPayload>;
}

// ---- parsing -------------------------------------------------------------

/** Parse the raw `arkData` field into the demo's `arkData` object shape. */
function parseArkData(raw: unknown): ArkData | null {
  if (raw && typeof raw === 'object') return raw as ArkData;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    return JSON.parse(raw) as ArkData;
  } catch {
    return null;
  }
}

/** Read a string field off the payload (anything non-string → ''). */
function s(p: ArkPayload, key: string): string {
  const v = p[key];
  return typeof v === 'string' ? v : '';
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

// ---- the universal card --------------------------------------------------

export function QqArk({ arkData }: { arkData: unknown }): ReactElement | null {
  const data = useMemo(() => parseArkData(arkData), [arkData]);

  // 1. 动态剥离外壳，取得底层真正的核心 Payload 数据块。
  const firstKey = data?.meta ? Object.keys(data.meta)[0] : undefined;
  const p: ArkPayload | null = data?.meta && firstKey ? data.meta[firstKey] ?? null : null;
  if (!data || !p) return null;

  // 群公告 (com.tencent.mannounce) 不走通用引擎：它的 title/text 是 base64
  // (encode=1)，且正文藏在 text 字段、没有任何图片素材，通用引擎会把原始
  // base64 当标题直接吐出来。单独渲染成公告卡。
  if (data.app === 'com.tencent.mannounce') {
    return <ArkGroupAnnounce p={p} />;
  }

  const prompt = typeof data.prompt === 'string' ? data.prompt : '';

  // 2. 提取核心物料特征。
  const appIcon = s(p, 'icon') || null; // 只有真正独立应用头部大标才算作 icon
  const footerIcon = s(p, 'tagIcon') || null; // 小尾巴/次级分类标识归为 tagIcon
  const mainImg = s(p, 'preview') || s(p, 'cover') || s(p, 'avatar') || null;
  const actionBtnText = s(p, 'button') || null;
  const jumpUrl = s(p, 'jumpUrl') || s(p, 'qqdocurl') || s(p, 'url') || '#';

  // 3. 动态文本特征映射。
  let componentHeader = '';
  let componentTitle = s(p, 'title') || s(p, 'summary') || s(p, 'nickname') || prompt || '';
  let componentDesc = s(p, 'desc') || s(p, 'contact') || s(p, 'address') || '';

  if (appIcon || p.appid) {
    // 小程序特征：有独立的 Header 头信息结构。
    componentHeader = s(p, 'title');
    componentTitle = s(p, 'desc');
    componentDesc = s(p, 'summary');
  } else if (s(p, 'nickname')) {
    // 联系人特征。
    componentHeader = s(p, 'tag') || '推荐联系人';
  }

  // 修正音乐组件特有的文案倒置特征。
  if (s(p, 'title') && s(p, 'summary') && s(p, 'title').includes('听歌')) {
    componentTitle = s(p, 'summary');
    componentDesc = s(p, 'title');
  }

  // 4. 智能形态拓扑判定（纯靠底层数据特征决定排版布局）。
  const lat = s(p, 'lat');
  const lng = s(p, 'lng');
  const hasMapFeature = !!(lat && lng);
  // 只有存在显式大封面(cover)、或应用图标配合预览(icon && preview)、或带交互按钮时，才激活大通栏布局。
  const isBlockLayout = !!(s(p, 'cover') || (appIcon && s(p, 'preview')) || actionBtnText);
  // 存在图片资源，且非大通栏、非地图的，自动降级为“左右紧凑型图文布局”。
  const isCompactLayout = !!(mainImg && !isBlockLayout && !hasMapFeature);

  // 5. 计算底部标签文本。
  let footerLabel = s(p, 'tag') || '';
  if (!footerLabel && prompt) {
    const match = prompt.match(/^\[(.*?)\]/);
    footerLabel = match?.[1] ?? '应用分享';
  }

  // 卡片整体点击：与 demo 一致，仅打开非 mqqapi 的 http(s) 链接（其余内部协议忽略）。
  const canOpen = !!jumpUrl && jumpUrl !== '#' && !jumpUrl.startsWith('mqqapi');
  const onOpen = (): void => {
    if (canOpen) window.open(jumpUrl, '_blank');
  };

  return (
    <div
      className="weq-ark-container"
      role={canOpen ? 'link' : undefined}
      title={canOpen ? jumpUrl : undefined}
      onClick={onOpen}
    >
      <div className="weq-ark-content">
        {/* A. 顶部横条（小程序应用头 / 名片分类头）。 */}
        {componentHeader || appIcon ? (
          <div className="weq-ark-header">
            {appIcon ? (
              <img className="weq-ark-icon-app" src={cachedAvatarUrl(appIcon) ?? appIcon} alt="" loading="lazy" />
            ) : null}
            <span>{componentHeader}</span>
          </div>
        ) : null}

        {/* B. 统一主标题。 */}
        {componentTitle ? <div className="weq-ark-title">{componentTitle}</div> : null}

        {/* C. 动态视图呈现分发。 */}
        {isCompactLayout ? (
          // 紧凑图文：描述在左，缩略图/头像卡在右边。
          <div className="weq-ark-body-compact">
            <div className="weq-ark-desc">{componentDesc}</div>
            {mainImg ? (
              <img
                className="weq-ark-preview-small"
                src={cachedAvatarUrl(mainImg) ?? mainImg}
                alt=""
                loading="lazy"
              />
            ) : null}
          </div>
        ) : (
          <>
            {/* 通栏：描述在上，大图/地图平铺在下方。 */}
            {componentDesc && !hasMapFeature ? (
              <div className="weq-ark-desc" style={{ marginBottom: 8 }}>
                {componentDesc}
              </div>
            ) : null}
            {hasMapFeature ? (
              <>
                <div className="weq-ark-desc" style={{ color: '#8c8c8c', marginBottom: 8 }}>
                  {componentDesc}
                </div>
                <ArkLocationMap lat={lat} lng={lng} name={s(p, 'name')} />
              </>
            ) : null}
            {isBlockLayout && mainImg ? (
              <img className="weq-ark-preview-big" src={cachedAvatarUrl(mainImg) ?? mainImg} alt="" loading="lazy" />
            ) : null}
          </>
        )}

        {/* D. 动作响应栏。 */}
        {actionBtnText ? <div className="weq-ark-action-btn">{actionBtnText}</div> : null}
      </div>

      {/* E. 统一底部来源栏（小尾巴）。 */}
      <div className="weq-ark-footer">
        {footerIcon ? (
          <img className="weq-ark-footer-icon" src={cachedAvatarUrl(footerIcon) ?? footerIcon} alt="" loading="lazy" />
        ) : null}
        <span>{footerLabel}</span>
      </div>
    </div>
  );
}

// ---- the group announcement card (com.tencent.mannounce) -----------------

/**
 * 群公告卡片。payload 里 title/text 为 base64 (encode=1)，无任何图片素材，
 * 所以不复用通用引擎。title 实为卡片头部标签（如「群公告」），text 才是正文；
 * 正文保留换行 (white-space: pre-wrap)，因为公告常带多行段落。卡片不可点击
 * （payload 只有 fid/gc/sign，没有可跳转的 http 链接）。
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

// ---- the location map (QQ 位置服务 static image) --------------------------

/**
 * MAP_KEY lifted verbatim from QQ's own `com.tencent.map` ark package
 * (…/arks/apps/com.tencent.map/…/index.js). QQ uses it against the same
 * `staticmap/v2` endpoint to draw the chat card's thumbnail; reusing it renders
 * a pixel-faithful map. It's a shared key — fine for rendering local data, but
 * heavy public traffic on it could get it throttled.
 */
const QQ_MAP_KEY = 'RJNBZ-56724-USWUA-XVB56-RWETV-AIBPS';

/**
 * Build the QQ 位置服务 static-map URL for a GCJ-02 lat/lng. `scale=2` returns a
 * retina PNG, `no_logo=1` drops the watermark. The location sits dead-centre
 * (center == the point) so the overlaid pin lines up without a baked marker.
 */
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

/**
 * The location card: a real QQ static-map image (funnelled through the
 * `weq-avatar://` disk cache so the server side fetches it and the renderer CSP
 * is satisfied) with a centred pin and place-name pill on top. The `.weq-ark-
 * map-view` backdrop stays behind as the offline/error fallback — if the image
 * 404s or the fetch fails, `onError` hides it and the CSS faux-map shows.
 */
function ArkLocationMap({ lat, lng, name }: { lat: string; lng: string; name: string }): ReactElement {
  const mapSrc = lat && lng ? cachedAvatarUrl(qqStaticMapUrl(lat, lng)) : null;
  return (
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
  );
}
