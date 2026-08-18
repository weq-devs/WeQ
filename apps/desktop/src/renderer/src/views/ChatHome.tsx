/**
 * 聊天页门面（无选中会话时的落地页）——「个性装扮」版。
 *
 * 素材全部取自 `settings.homeDress`（bootstrap 阶段写入的快照，见 user_config.ts），
 * 首页只读、不实时拉取。四层自下而上（部件本体在 components/dressPieces，与他人的
 * 个性主页共用）：
 *
 *   ① 背景：名片装扮。有视频就播视频、否则用静图；两者都无则整层不渲染，透出主题画布。
 *   ② 浮屏：方形小图从上方随机位置旋转下落，同一时刻 2–4 个。没有就不飘。
 *   ③ 头像：挂件 PNG（实测是 APNG，浏览器自己会动）覆在头像外圈；没有挂件时退回原来的
 *     波浪环。
 *   ④ 个性标签：半透明圆片，入场时与头像完全重叠，随后展开到四周较远处并持续浮动；
 *     一个标签都没有时退回一言打字机。
 *
 * 有背景时整页文字改用亮色 + 阴影（名片多是深色照片），故 `.is-onphoto` 一档。
 */

import { useEffect, useState } from 'react';
import { AvatarOrb, CardBackdrop, ScreenRain, TagRing } from '../components/dressPieces';
import { dressUrl } from '../lib/resourceUrl';
import { useThemeStore } from '../state/theme';
import { trpc } from '../trpc/client';

interface Verse {
  text: string;
  from: string;
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

/**
 * 一言打字机（无个性标签时的降级）。取随机一句逐字打出，打完即定格——光标继续闪烁、
 * 句子不再切换。随机性来自后端每次进首页重新洗牌（verses[0] 即随机）。
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

export function ChatHome({
  nickname,
  avatarUrl: selfAvatarUrl = null,
}: {
  nickname: string;
  avatarUrl?: string | null;
}) {
  // 订阅深浅色:被拦截的会员广告占位图按主题换图,主题切换时 URL 要重建重拉。
  useThemeStore((s) => s.resolved);
  const dressQuery = trpc.account.getHomeDress.useQuery(undefined, {
    refetchOnWindowFocus: false,
    // 首次进入时 fetchHomeDress 可能还在后台写入，轮询直到拿到数据
    refetchInterval: (data) => (data ? false : 2000),
  });
  const dress = dressQuery.data;
  const tags = dress?.tags ?? [];

  // 有个性标签就不再显示一言（两者占同一块视觉区域）。
  const wantHitokoto = tags.length === 0;
  const hitokoto = trpc.account.sampleHitokoto.useQuery(
    { count: 40 },
    { enabled: wantHitokoto, refetchOnMount: 'always', refetchOnWindowFocus: false },
  );

  const verses = (hitokoto.data ?? []) as Verse[];
  const name = nickname?.trim() || 'there';

  const widgetUrl = dressUrl(dress?.widgetUrl ?? '');
  const cardUrl = dressUrl(dress?.cardUrl ?? '');
  const cardVideoUrl = dressUrl(dress?.cardVideoUrl ?? '');
  const screenUrl = dressUrl(dress?.screenUrl ?? '');
  const hasBackdrop = Boolean(cardUrl || cardVideoUrl);

  return (
    <section
      className={`weq-chathome weq-anim-fade${hasBackdrop ? ' is-onphoto' : ''}${
        tags.length === 0 ? ' is-notags' : ''
      }`}
    >
      <CardBackdrop imageUrl={cardUrl} videoUrl={cardVideoUrl} />
      {screenUrl && <ScreenRain src={screenUrl} />}

      <div className="weq-chathome-inner">
        <div className="weq-chathome-hero">
          <div className="weq-chathome-stage">
            <AvatarOrb avatarUrl={selfAvatarUrl} nickname={name} widgetUrl={widgetUrl} />
            <TagRing tags={tags} />
          </div>
          <h1 className="weq-chathome-greet">
            <span className="weq-chathome-greet-hi">{greetWord()},</span>
            <span className="weq-chathome-greet-name">{name}</span>
          </h1>
        </div>

        {wantHitokoto && verses.length > 0 && <HitokotoTicker verses={verses} />}
      </div>
    </section>
  );
}
