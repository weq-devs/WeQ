/**
 * 他人的「个性主页」——竖屏卡片，把 QQ 会员装扮和资料里好看的那部分摆在一起。
 *
 * 与首页（{@link ../views/ChatHome}）共用 {@link ./dressPieces} 的四层部件，视觉一致；
 * 区别是这里不放问候语和打字机，头像下方改为账号信息（特权徽章 / 所在地 / 个性标签 /
 * 精选图）。刻意不显示 uid —— 这是一张给人看的卡片，不是调试面板。
 *
 * 数据分两路：
 *  - **装扮**（挂件 / 名片 / 浮屏）必须联网：走 `dressup.peerHome`，后端抓 QQ 会员的
 *    SSR 装扮页，要该账号的 p_skey，因此需要 QQ 客户端在线。SSR 页面本身就慢（数秒），
 *    所以这一路单独一个 query + 骨架动画，不阻塞资料。
 *  - **资料**（标签 / 特权 / 所在地 / 精选图）来自 profile_info_v6，本地库直接有，
 *    调用方（资料灯箱）已经拿在手里，原样传进来即可。
 */

import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, MapPin, Sparkles, WifiOff, X } from 'lucide-react';
import { AvatarOrb, CardBackdrop, ScreenRain, TagRing } from './dressPieces';
import { openLightbox } from './ImageLightbox';
import { albumMediaUrl, collectionImageUrl, dressUrl } from '../lib/resourceUrl';
import { trpc } from '../trpc/client';

/** 与资料灯箱同一份形状（profilePanes 的 ProfileExtInfo），只取渲染要用的字段。 */
export interface PersonalityHomeProfile {
  name: string;
  avatarUrl: string | null;
  signature?: string | null;
  /** 个性标签（extInfo.interests）。 */
  interests: string[];
  /** 已开通的特权图标（extInfo.privileges 里 opened 且有 iconUrl 的）。 */
  privileges: Array<{ bizId?: number; level?: number; iconUrl?: string; label: string }>;
  /** 所在地（国/省/市已拼好），空则不显示。 */
  region?: string | null;
  /** 精选图（缩略图 url + 大图 url）。 */
  album: Array<{ thumb: string; full: string }>;
}

export function PersonalityHomeDialog({
  uin,
  profile,
  onClose,
}: {
  /** 目标 QQ 号。装扮页只认 uin，拿不到 uin 的联系人不该开这个入口。 */
  uin: string;
  profile: PersonalityHomeProfile;
  onClose: () => void;
}) {
  const dress = trpc.account.dressup.peerHome.useQuery(
    { uin },
    // SSR 页面每次都要几秒，失败多半是票据/风控而不是抖动，重试只会让用户多等一轮。
    { retry: false, refetchOnWindowFocus: false, staleTime: 5 * 60_000 },
  );

  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const widgetUrl = dressUrl(dress.data?.widgetUrl ?? '');
  const cardUrl = dressUrl(dress.data?.cardUrl ?? '');
  const cardVideoUrl = dressUrl(dress.data?.cardVideoUrl ?? '');
  const screenUrl = dressUrl(dress.data?.screenUrl ?? '');
  const hasBackdrop = Boolean(cardUrl || cardVideoUrl);
  const tags = profile.interests;

  return createPortal(
    <div
      className="weq-profile-layer weq-perhome-layer"
      role="presentation"
      // 必须 stopPropagation：portal 挂在 body 上，但 React 事件仍沿**组件树**冒泡，
      // 而调用方（好友资料灯箱）的遮罩也监听 mousedown 关闭自己 —— 不拦就是点一次关两层。
      onMouseDown={(event) => {
        event.stopPropagation();
        onClose();
      }}
    >
      <section
        className={`weq-perhome weq-anim-pop${hasBackdrop ? ' is-onphoto' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={`${profile.name} 的个性主页`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <CardBackdrop imageUrl={cardUrl} videoUrl={cardVideoUrl} />
        {screenUrl && <ScreenRain src={screenUrl} count={5} />}

        <button
          className="weq-perhome-close"
          type="button"
          title="关闭"
          aria-label="关闭"
          onClick={onClose}
        >
          <X size={16} />
        </button>

        <div className="weq-perhome-inner">
          {/* 标签环是绝对定位的，撑不开舞台高度，故靠 .has-tags 补一段下方间距。
              没标签时不能留那段空白——否则昵称被推到卡片外看不见。 */}
          <div className={`weq-perhome-stage${tags.length ? ' has-tags' : ''}`}>
            <AvatarOrb
              avatarUrl={profile.avatarUrl}
              nickname={profile.name}
              widgetUrl={widgetUrl}
            />
            <TagRing tags={tags} max={8} radiusPad={34} />
          </div>

          <h2 className="weq-perhome-name">{profile.name}</h2>
          {profile.signature ? <p className="weq-perhome-sign">{profile.signature}</p> : null}

          {profile.privileges.length || profile.region ? (
            <div className="weq-perhome-chips">
              {profile.region ? (
                <span className="weq-perhome-chip">
                  <MapPin size={12} />
                  {profile.region}
                </span>
              ) : null}
              {dress.data?.isSvip ? (
                <span className="weq-perhome-chip is-svip">
                  <Sparkles size={12} />
                  超级会员
                </span>
              ) : null}
              {profile.privileges.map((item, index) => (
                <img
                  // biome-ignore lint/suspicious/noArrayIndexKey: 同一 bizId 可能出现多条,只有位置是稳定键
                  key={`${item.bizId ?? '?'}:${index}`}
                  className="weq-perhome-privilege"
                  src={collectionImageUrl(item.iconUrl as string)}
                  alt={item.label}
                  title={item.level ? `${item.label} · ${item.level} 级` : item.label}
                  loading="lazy"
                />
              ))}
            </div>
          ) : null}

          {profile.album.length ? (
            <div className="weq-perhome-album">
              {profile.album.map((photo, index) => (
                <button
                  // biome-ignore lint/suspicious/noArrayIndexKey: 同一张图可能多次出现,位置才是稳定键
                  key={`${photo.thumb}:${index}`}
                  type="button"
                  className="weq-perhome-photo"
                  title="精选图片"
                  onClick={() => openLightbox(albumMediaUrl(photo.full), '精选图片')}
                >
                  <img src={albumMediaUrl(photo.thumb)} alt="" loading="lazy" />
                </button>
              ))}
            </div>
          ) : null}

          <div className="weq-perhome-status">
            {dress.isLoading ? (
              <span className="weq-perhome-loading">
                <Loader2 size={13} />
                正在获取个性装扮…
              </span>
            ) : dress.error ? (
              <span className="weq-perhome-offline">
                <WifiOff size={13} />
                {dress.error.message}
              </span>
            ) : null}
          </div>
        </div>
      </section>
    </div>,
    document.body,
  );
}
