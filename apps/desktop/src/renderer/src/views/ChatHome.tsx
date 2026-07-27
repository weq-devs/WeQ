/**
 * 聊天页门面（无选中会话时的落地页）。三段式，纯装饰、无交互：
 *
 *   ① 品牌合影：自己的 QQ 头像与 WeQ logo 各套一圈「流动波浪环」（正弦扰动的圆缓速
 *     旋转），中间一条流动的波浪线相连——寓意
 *     「你的 QQ 数据流入 WeQ」。下接大字细体问候（按时间 Good morning/… + QQ 昵称）
 *   ② 一言打字机：从 hitokoto 池随机取一句，逐字打出后定格（光标继续闪烁、不再切换句）
 *   ③ 记忆长廊：把私聊里「别人发来」的真实短句排成一条时间线，纯 CSS 匀速上浮（悬停
 *     暂停），像回忆浮现又淡去——真·旧消息就是最贴「回忆」主题的素材
 *
 * 数据走只读 trpc（account.sampleHitokoto / account.sampleChatLines），每次进首页都
 * 重新请求（refetchOnMount: 'always'）→ 后端每次重新洗牌 → 每次打开都换一批。
 *
 * 性能：打字机每几十毫秒 setState，故拆成独立子组件隔离高频重渲染；记忆长廊则完全零
 * setState——滚动交给 CSS transform（GPU 合成，不触发布局），既不卡也不会有旧实现里
 * 「正在输入」气泡溢出被 mask 裁掉的问题。组件仅在空态挂载，选中会话即卸载，打字机定
 * 时器随之清理。
 */

import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import logoUrl from '@resources/brand/logo.png';
import { trpc } from '../trpc/client';

interface Verse {
  text: string;
  from: string;
}

interface StreamLine {
  text: string;
  uin: string;
  name: string;
}

/** QQ 号 → 头像 URL（与 MainView.senderAvatarSrc 同源）。 */
function avatarUrl(uin: string): string | null {
  return uin && uin !== '0' ? `https://thirdqq.qlogo.cn/g?b=sdk&s=0&nk=${uin}` : null;
}

/** 按当前时刻给英文问候语。 */
function greetWord(): string {
  const h = new Date().getHours();
  if (h < 5) return 'Good night';
  if (h < 11) return 'Good morning';
  if (h < 13) return 'Hello';
  if (h < 18) return 'Good afternoon';
  if (h < 23) return 'Good evening';
  return 'Good night';
}

/** 小头像：有 QQ 号走 qlogo，取不到则用昵称首字兜底。 */
function Avatar({ uin, name }: { uin: string; name: string }) {
  const src = avatarUrl(uin);
  if (src) {
    return (
      <img className="weq-chathome-avatar" src={src} alt="" loading="lazy" draggable={false} />
    );
  }
  return (
    <span className="weq-chathome-avatar weq-chathome-avatar-fallback">
      {(name || '?').slice(0, 1)}
    </span>
  );
}

/**
 * ② 一言打字机（独立组件，隔离高频 setState）。取随机一句逐字打出，打完即定格——
 * 光标继续闪烁、句子不再切换。随机性来自后端每次进首页重新洗牌（verses[0] 即随机）。
 */
function HitokotoTicker({ verses }: { verses: Verse[] }) {
  const [display, setDisplay] = useState('');
  const [from, setFrom] = useState('');
  const [showFrom, setShowFrom] = useState(false);

  useEffect(() => {
    if (verses.length === 0) return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const verse = verses[0]!;
    const chars = [...verse.text];
    setFrom(verse.from);
    setShowFrom(false);
    setDisplay('');
    let i = 0;

    const typeChar = (): void => {
      if (cancelled) return;
      i += 1;
      setDisplay(chars.slice(0, i).join(''));
      if (i < chars.length) {
        timer = setTimeout(typeChar, 58 + Math.random() * 52);
      } else {
        // 打完定格：显示出处，光标留在句尾继续闪烁，不再退回/切换。
        setShowFrom(true);
      }
    };

    timer = setTimeout(typeChar, 280);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [verses]);

  return (
    <div className="weq-chathome-hitokoto">
      <p className="weq-chathome-verse">
        <span>{display}</span>
        <span className="weq-chathome-caret" aria-hidden />
      </p>
      <p className={`weq-chathome-from${showFrom && from ? ' is-shown' : ''}`}>
        {from ? `—— ${from}` : ''}
      </p>
    </div>
  );
}

/** 时钟图标（见出し用的小装饰，暗示「过去」）。 */
function ClockGlyph() {
  return (
    <svg className="weq-lane-clock" viewBox="0 0 24 24" width="14" height="14" aria-hidden>
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M12 7.4v5l3.2 1.9"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** 单条记忆：时间线节点 + 头像 + 昵称 + 一句旧话。 */
function MemoryItem({ line }: { line: StreamLine }) {
  return (
    <li className="weq-lane-item">
      <span className="weq-lane-node" aria-hidden />
      <Avatar uin={line.uin} name={line.name} />
      <div className="weq-lane-body">
        <span className="weq-lane-name">{line.name}</span>
        <p className="weq-lane-text">{line.text}</p>
      </div>
    </li>
  );
}

/**
 * ③ 记忆长廊（独立组件，零 setState）：把旧消息排成一条时间线，纯 CSS `transform`
 * 匀速上浮。轨道内容复制两份、位移 -50% 无缝循环；速度按条数比例（每条约 3.6s）保持
 * 恒定；悬停暂停，方便停下来读某一句。相比旧「聊天窗」既无高频重渲染（不卡），也没有
 * 「正在输入」气泡溢出被 mask 裁掉的问题。
 */
function MemoryLane({ lines }: { lines: StreamLine[] }) {
  // 取一段有限长度，够铺满两屏循环即可，避免 DOM 过大。
  const items = lines.slice(0, 22);
  if (items.length === 0) return null;

  // 时长与条数成正比 → 视觉速度恒定，且不因条数少而转得飞快。
  const durationSec = Math.max(26, items.length * 3.6);
  const trackStyle = { '--weq-lane-duration': `${durationSec}s` } as CSSProperties;

  return (
    <div className="weq-lane" aria-hidden>
      <div className="weq-lane-head">
        <ClockGlyph />
        <span>那些他们说过的话</span>
      </div>
      <div className="weq-lane-viewport">
        <ul className="weq-lane-track" style={trackStyle}>
          {items.map((line, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 列表按位置渲染,无稳定唯一键
            <MemoryItem key={`a-${i}`} line={line} />
          ))}
          {/* 第二份副本，供无缝循环（对屏幕阅读器隐藏，故无需唯一语义 key） */}
          {items.map((line, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 列表按位置渲染,无稳定唯一键
            <MemoryItem key={`b-${i}`} line={line} />
          ))}
        </ul>
      </div>
    </div>
  );
}

/**
 * 记忆长廊暂时隐藏（保留全部实现，改天想要直接翻 true 即可复活）。隐藏时首页只留
 * ① 问候 + ② 一言，靠 .weq-chathome-inner 的 flex 居中自动回正、不留空档。
 */
const SHOW_MEMORY_LANE = false;

/**
 * 生成「波浪圆环」路径：半径为 r 的圆叠加正弦扰动（lobes 个波瓣、振幅 amp），
 * 采样成闭合折线。采样密度足够高时视觉上即光滑曲线。配合 CSS 缓速旋转，
 * 波浪看起来就在环上流动（参考 Gemini 的波浪 loading 边框）。
 */
function wavyRingPath(r: number, amp: number, lobes: number, size: number): string {
  const c = size / 2;
  const steps = 180;
  const pts: string[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = (i / steps) * Math.PI * 2;
    const rr = r + amp * Math.sin(lobes * t);
    pts.push(`${(c + rr * Math.cos(t)).toFixed(2)} ${(c + rr * Math.sin(t)).toFixed(2)}`);
  }
  return `M${pts.join('L')}Z`;
}

/** 横向正弦波路径（波长 wl、振幅 amp、总宽 w，垂直居中于 h/2）。 */
function sineWavePath(w: number, h: number, wl: number, amp: number): string {
  const mid = h / 2;
  const step = wl / 24; // 每个波长采 24 点，足够光滑
  const pts: string[] = [];
  for (let x = 0; x <= w; x += step) {
    pts.push(`${x.toFixed(2)} ${(mid + amp * Math.sin((x / wl) * Math.PI * 2)).toFixed(2)}`);
  }
  return `M${pts.join('L')}`;
}

/* 波浪环路径是纯几何常量，模块级算一次即可。外环波瓣多而浅、内环波瓣少而深，
   两环反向旋转 → 干涉出「水面微漾」的错觉。 */
const ORB_VIEW = 120;
const ORB_RING_OUTER = wavyRingPath(54, 2.6, 9, ORB_VIEW);
const ORB_RING_INNER = wavyRingPath(49.5, 2, 6, ORB_VIEW);

/* 连接线：视口 64px 宽，路径多画两个波长（48px），动画平移一个波长即无缝循环。 */
const LINK_W = 64;
const LINK_H = 20;
const LINK_WL = 24;
const LINK_PATH = sineWavePath(LINK_W + LINK_WL * 2, LINK_H, LINK_WL, 3.1);

/**
 * 一枚「光球」：中心图片（QQ 头像 / WeQ logo）+ 两圈反向缓旋的波浪环。
 * kind 区分左右两球（错开浮动相位、环转速略不同，避免完全同步的机械感）。
 */
function BrandOrb({
  src,
  alt,
  kind,
  round,
}: {
  src: string;
  alt: string;
  kind: 'self' | 'weq';
  round: boolean;
}) {
  return (
    <span className={`weq-orb weq-orb-${kind}`}>
      <svg className="weq-orb-rings" viewBox={`0 0 ${ORB_VIEW} ${ORB_VIEW}`} aria-hidden>
        <path className="weq-orb-ring weq-orb-ring-outer" d={ORB_RING_OUTER} />
        <path className="weq-orb-ring weq-orb-ring-inner" d={ORB_RING_INNER} />
      </svg>
      <img
        src={src}
        alt={alt}
        className={`weq-orb-img${round ? ' is-round' : ''}`}
        draggable={false}
      />
    </span>
  );
}

/** 两球之间的流动波浪线：路径向左匀速平移一个波长后瞬回，视觉上无缝流动。 */
function WaveLink() {
  return (
    <span className="weq-wavelink" aria-hidden>
      <svg viewBox={`0 0 ${LINK_W} ${LINK_H}`} width={LINK_W} height={LINK_H}>
        <path className="weq-wavelink-path" d={LINK_PATH} />
      </svg>
    </span>
  );
}

/**
 * ① 品牌合影：QQ 头像与 WeQ logo 两枚「波浪环光球」，中间一条流动的波浪线相连。
 * 头像取不到（未登录/CDN 挂）时降级为单独一枚 logo 光球，不留空洞。
 */
function BrandPair({ avatarUrl, nickname }: { avatarUrl: string | null; nickname: string }) {
  if (!avatarUrl) {
    return (
      <div className="weq-chathome-pair is-solo">
        <BrandOrb src={logoUrl} alt="WeQ" kind="weq" round={false} />
      </div>
    );
  }
  return (
    <div className="weq-chathome-pair">
      <BrandOrb src={avatarUrl} alt={nickname} kind="self" round />
      <WaveLink />
      <BrandOrb src={logoUrl} alt="WeQ" kind="weq" round={false} />
    </div>
  );
}

export function ChatHome({
  nickname,
  avatarUrl: selfAvatarUrl = null,
}: {
  nickname: string;
  avatarUrl?: string | null;
}) {
  const hitokoto = trpc.account.sampleHitokoto.useQuery(
    { count: 40 },
    { refetchOnMount: 'always', refetchOnWindowFocus: false },
  );
  const chatLines = trpc.account.sampleChatLines.useQuery(
    { limit: 90 },
    // 隐藏时不必再拉取旧消息。
    { enabled: SHOW_MEMORY_LANE, refetchOnMount: 'always', refetchOnWindowFocus: false },
  );

  const verses = (hitokoto.data ?? []) as Verse[];
  const lines = (chatLines.data ?? []) as StreamLine[];
  const name = nickname?.trim() || 'there';

  return (
    <section className="weq-chathome weq-anim-fade">
      <div className="weq-chathome-inner">
        <div className="weq-chathome-hero">
          <BrandPair avatarUrl={selfAvatarUrl} nickname={name} />
          <h1 className="weq-chathome-greet">
            <span className="weq-chathome-greet-hi">{greetWord()},</span>
            <span className="weq-chathome-greet-name">{name}</span>
          </h1>
        </div>

        {verses.length > 0 && <HitokotoTicker verses={verses} />}
        {SHOW_MEMORY_LANE && lines.length > 0 && <MemoryLane lines={lines} />}
      </div>
    </section>
  );
}
