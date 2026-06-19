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
 * The map (Location.Search) is the one piece that can't be ported verbatim: the
 * demo's Leaflet widget pulls OSM tiles straight from the browser, which the
 * renderer CSP blocks (`script-src 'self'`, no openstreetmap in `img-src`, no
 * `frame-src` for an embed). Proxying the tiles through `weq-avatar://` doesn't
 * help either — that fetch is server-side (non-browser UA + empty Referer), and
 * OSM's tile policy answers it with HTTP 418 "access blocked". So we render a
 * dependency-free, network-free location placeholder (faux-map backdrop + pin +
 * place name); the human-readable address is already shown above it.
 */

import { useMemo, type ReactElement } from 'react';
import { MapPin } from 'lucide-react';
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

// ---- the universal card --------------------------------------------------

export function QqArk({ arkData }: { arkData: unknown }): ReactElement | null {
  const data = useMemo(() => parseArkData(arkData), [arkData]);

  // 1. 动态剥离外壳，取得底层真正的核心 Payload 数据块。
  const firstKey = data?.meta ? Object.keys(data.meta)[0] : undefined;
  const p: ArkPayload | null = data?.meta && firstKey ? data.meta[firstKey] ?? null : null;
  if (!data || !p) return null;

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
                <ArkLocationMap name={s(p, 'name')} />
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

// ---- the location placeholder (Leaflet substitute) -----------------------

/**
 * A network-free location card: a faux-map backdrop (CSS only — see
 * `.weq-ark-map-view` styles) with a centred pin and the place name. We
 * deliberately render NO real tiles: OSM blocks the proxy's server-side fetch
 * with HTTP 418, and loading tiles straight from the renderer would need a CSP
 * carve-out plus reliance on OSM's tile policy. The address sits above this in
 * the card body, so the coordinate itself is the only thing we drop.
 */
function ArkLocationMap({ name }: { name: string }): ReactElement {
  return (
    <div className="weq-ark-map-view">
      <MapPin className="weq-ark-map-pin" size={28} strokeWidth={2.2} />
      {name ? <span className="weq-ark-map-name">{name}</span> : null}
    </div>
  );
}
