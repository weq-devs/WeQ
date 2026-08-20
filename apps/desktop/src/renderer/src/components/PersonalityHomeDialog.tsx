/**
 * 他人的「个性主页」——竖屏卡片，把 QQ 会员装扮和资料里好看的那部分摆在一起。
 *
 * 与首页（{@link ../views/ChatHome}）共用 {@link ./dressPieces} 的四层部件，视觉一致；
 * 区别是这里不放问候语和打字机，头像下方改为账号信息（特权徽章 / 所在地 / 个性标签 /
 * 精选图）。刻意不显示 uid —— 这是一张给人看的卡片，不是调试面板。
 *
 * 数据分三路：
 *  - **装扮**（挂件 / 名片 / 浮屏）必须联网：走 `dressup.peerHome`，后端抓 QQ 会员的
 *    SSR 装扮页，要该账号的 p_skey，因此需要 QQ 客户端在线。SSR 页面本身就慢（数秒），
 *    所以这一路单独一个 query + 骨架动画，不阻塞资料。
 *  - **资料**（标签 / 特权 / 所在地 / 精选图）来自 profile_info_v6，本地库直接有，
 *    调用方（资料灯箱）已经拿在手里，原样传进来即可。
 *  - **统计**（QQ 等级 + 累计获赞）走 `dressup.peerStats`：两条 OIDB 都要在线实例发包，
 *    但比 SSR 快得多（毫秒级），数据到了再补一行徽章，不占骨架。
 *  - **QQ 秀**（透明全身像）走 `dressup.peerQqShow`：同是毫秒级 OIDB（0xFE1_3），有 QQ 秀时
 *    默认用全身像替换「头像+挂件」，舞台底部的胶囊可一键切回。
 */

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Heart, Loader2, MapPin, Sparkles, UserRound, WifiOff, X } from 'lucide-react';
import { AvatarOrb, CardBackdrop, ScreenRain, TagRing } from './dressPieces';
import { openLightbox } from './ImageLightbox';
import {
  albumMediaUrl,
  collectionImageUrl,
  dressUrl,
  qqShowUrl,
  resourceUrl,
} from '../lib/resourceUrl';
import { trpc } from '../trpc/client';
import botCardUrl from '@resources/img/bot.png';

/**
 * QQ 等级按 4 进制拆成图标序列：1 星 / 4 月 / 16 日 / 64 冠 / 256 企鹅，
 * 从大到小排（企鹅 → 皇冠 → 太阳 → 月亮 → 星星），每档最多 3 个。
 * 等级 0（新号 / 查询未命中）只画一枚半星。顶位企鹅超过 3 只时补一枚「…」。
 */
function qqLevelIconNames(level: number): string[] {
  if (level <= 0) return ['half'];
  const units: Array<{ name: string; value: number }> = [
    { name: 'penguin', value: 256 },
    { name: 'crown', value: 64 },
    { name: 'sun', value: 16 },
    { name: 'moon', value: 4 },
    { name: 'star', value: 1 },
  ];
  const icons: string[] = [];
  let rest = level;
  for (const { name, value } of units) {
    const count = Math.min(Math.floor(rest / value), 3);
    rest %= value;
    for (let i = 0; i < count; i++) icons.push(name);
    if (name === 'penguin' && count === 3 && level >= 4 * value) icons.push('more');
  }
  return icons;
}

/** 获赞数超过一万按「万」缩略（12345 → 1.2万）。 */
function formatLikeCount(count: number): string {
  if (count < 10000) return String(count);
  const wan = count / 10000;
  return `${Math.round(wan * 10) / 10}万`;
}

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
  uid,
  profile,
  isBot = false,
  onClose,
}: {
  /** 目标 QQ 号。装扮页只认 uin，拿不到 uin 的联系人不该开这个入口。 */
  uin: string;
  /** 目标 uid（0x7ED_12 按 uid 查获赞）。资料灯箱/群成员卡都有，拿不到就只显示等级。 */
  uid?: string;
  profile: PersonalityHomeProfile;
  /** 机器人没有会员装扮，跳过联网请求，直接用内置名片。 */
  isBot?: boolean;
  onClose: () => void;
}) {
  const dress = trpc.account.dressup.peerHome.useQuery(
    { uin },
    // SSR 页面每次都要几秒，失败多半是票据/风控而不是抖动，重试只会让用户多等一轮。
    { enabled: !isBot, retry: false, refetchOnWindowFocus: false, staleTime: 5 * 60_000 },
  );
  const stats = trpc.account.dressup.peerStats.useQuery(
    { uin, uid: uid ?? '' },
    {
      enabled: Boolean(uid) && !isBot,
      retry: false,
      refetchOnWindowFocus: false,
      staleTime: 5 * 60_000,
    },
  );
  const qqShow = trpc.account.dressup.peerQqShow.useQuery(
    { uin },
    // OIDB 毫秒级返回；失败多半是离线/风控，静默回退到头像+挂件即可，不打扰。
    { enabled: !isBot, retry: false, refetchOnWindowFocus: false, staleTime: 5 * 60_000 },
  );

  // 有 QQ 秀时默认展示全身像；切换胶囊可随时切回「头像+挂件」。
  const [showQqShow, setShowQqShow] = useState(true);
  // 全身像加载失败（CDN 挂了 / 图被删）就回退到头像，避免裂图。
  const [qqShowFailed, setQqShowFailed] = useState(false);
  const qqShowUrlValue = qqShow.data?.hasShow ? qqShow.data.url : '';

  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const widgetUrl = dressUrl(dress.data?.widgetUrl ?? '');
  const cardUrl = isBot ? botCardUrl : dressUrl(dress.data?.cardUrl ?? '');
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
          <div
            className={`weq-perhome-stage${tags.length ? ' has-tags' : ''}${qqShowUrlValue && showQqShow && !qqShowFailed ? ' has-qqshow' : ''}`}
          >
            {showQqShow && qqShowUrlValue && !qqShowFailed ? (
              <img
                className="weq-qqshow"
                src={qqShowUrl(qqShowUrlValue)}
                alt={profile.name}
                draggable={false}
                onError={() => setQqShowFailed(true)}
              />
            ) : (
              <AvatarOrb
                avatarUrl={profile.avatarUrl}
                nickname={profile.name}
                widgetUrl={widgetUrl}
              />
            )}
            <TagRing tags={tags} max={8} radiusPad={34} />

            {qqShowUrlValue ? (
              <div className="weq-perhome-show-switch" role="group" aria-label="切换形象展示">
                <button
                  type="button"
                  className={showQqShow ? 'is-active' : ''}
                  title="QQ 秀形象"
                  aria-label="QQ 秀形象"
                  aria-pressed={showQqShow}
                  onClick={() => {
                    setQqShowFailed(false);
                    setShowQqShow(true);
                  }}
                >
                  <Sparkles size={13} />
                </button>
                <button
                  type="button"
                  className={!showQqShow ? 'is-active' : ''}
                  title="头像 + 挂件"
                  aria-label="头像 + 挂件"
                  aria-pressed={!showQqShow}
                  onClick={() => setShowQqShow(false)}
                >
                  <UserRound size={13} />
                </button>
              </div>
            ) : null}
          </div>

          <h2 className="weq-perhome-name">{profile.name}</h2>
          {profile.signature ? <p className="weq-perhome-sign">{profile.signature}</p> : null}

          {stats.data ? (
            <div className="weq-perhome-stats">
              <span className="weq-perhome-stat" title={`QQ 等级 ${stats.data.level} 级`}>
                <span className="weq-perhome-level-icons">
                  {qqLevelIconNames(stats.data.level).map((name, index) => (
                    <img
                      // biome-ignore lint/suspicious/noArrayIndexKey: 同名图标可重复,位置才是稳定键
                      key={`${name}:${index}`}
                      src={resourceUrl('qqlevel', '4', `${name}.png`)}
                      alt=""
                    />
                  ))}
                </span>
                <strong>Lv.{stats.data.level}</strong>
              </span>
              <span
                className="weq-perhome-stat weq-perhome-stat-like"
                title={`累计获赞 ${stats.data.likeCount}`}
              >
                <Heart size={13} fill="currentColor" />
                <strong>{formatLikeCount(stats.data.likeCount)}</strong>
                <span>获赞</span>
              </span>
            </div>
          ) : null}

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
            {isBot ? null : dress.isLoading ? (
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
