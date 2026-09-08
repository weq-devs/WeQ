import { useMemo, useState, type CSSProperties, type ReactElement } from 'react';
import { ImageOff } from 'lucide-react';
import type { VoicePageData, VoicePicFavorite, VoiceWord } from '@weq/service';
import { isAllTimeYear, reportEraLabel } from '@weq/service/report-time';
import { PageFrame, type ReportPageProps } from '../pageFrame';
import { FaceEmoji } from '../../../components/FaceEmoji';
import { mediaUrl } from '../../../lib/resourceUrl';

function fmt(n: number): string {
  return new Intl.NumberFormat('zh-CN').format(n);
}

const CLOUD_LIMIT = 22;
/** 系统表情榜在页面上画几位（服务端多留一名，画面前几名即可）。 */
const FACE_SHOW = 4;
/** 按名次递减的贴图尺寸：最多最大，老朋友顺位变小。 */
const FACE_TILE_SIZES = [92, 66, 56, 50];

/**
 * 我的话 —— 一页只有一个主角：你说得最多的那个词。
 *
 * 它不解释、不排行，就那样占在页面正中 —— 词有多大，重复就有多重。
 * 系统表情小榜（第一名最大、老朋友顺位变小）与一枚自定义表情只是大词旁边的
 * 小注脚：它们跟口头禅一样，是**被你说过最多次的东西**，所以不放进任何排行榜，
 * 只并排摆在一起，像一句没说完的话被收进同一条底线。
 *
 * 背景是同一批 top words 散成的词云：混乱、很低饱和、慢慢地漂 —— 是回忆的底噪，
 * 不是又一个可读的组件。
 */
export function VoicePage({ page, data, active }: ReportPageProps<VoicePageData>): ReactElement {
  const allTime = isAllTimeYear(data.year);
  const hero = data.word;
  const heroCount = hero?.count ?? 0;
  const faces = data.faces.slice(0, FACE_SHOW);
  const hasFaces = faces.length > 0;

  const mood =
    heroCount > 0
      ? `说了 ${fmt(heroCount)} 次。不是词穷——是这句话每次都刚好，接住了当时的心情。`
      : '这一页很安静。下一个被你说熟的词，还在路上。';

  return (
    <PageFrame page={page} active={active} ghost="说" ghostPlacement="bottom-right">
      <div className="weq-vc">
        {data.cloud.length > 0 ? <WordCloud words={data.cloud} active={active} /> : null}

        <header className="weq-vc-kicker weq-report-line" style={{ '--i': 1 } as CSSProperties}>
          <span>{reportEraLabel(data.year)} · 我的话</span>
          <span className="weq-vc-kicker-meta">
            <b className="weq-number">{fmt(data.sentTotal)}</b> 条发言
            <i aria-hidden>/</i>
            <b className="weq-number">{fmt(data.faceTotal)}</b> 个系统表情
            {data.picTotal > 0 ? (
              <>
                <i aria-hidden>/</i>
                <b className="weq-number">{fmt(data.picTotal)}</b> 张自定义表情
              </>
            ) : null}
          </span>
        </header>

        <section className="weq-vc-hero">
          {hero ? (
            <>
              <p className="weq-vc-lede weq-report-line" style={{ '--i': 2 } as CSSProperties}>
                {allTime ? '从有记录到现在' : `${data.year} 这一年`}，被你说得最烫的一个词是
              </p>
              <h2 className={`weq-vc-word${hero.word.length >= 5 ? ' is-long' : ''}`}>
                {hero.word}
              </h2>
              <p
                className="weq-vc-word-count weq-report-line"
                style={{ '--i': 3 } as CSSProperties}
              >
                <i aria-hidden />
                说了 <b className="weq-number">{fmt(hero.count)}</b> 次
                <i aria-hidden />
              </p>
            </>
          ) : (
            <p className="weq-vc-lede weq-report-line" style={{ '--i': 2 } as CSSProperties}>
              这一年，你的每一句话都是现场发挥的。
            </p>
          )}
        </section>

        {hasFaces || data.pic ? (
          <section className="weq-vc-faves weq-report-line" style={{ '--i': 4 } as CSSProperties}>
            <p className="weq-vc-faves-in">而表情，是你说不出口的那部分——</p>
            <div className="weq-vc-faves-row">
              {hasFaces ? (
                <div className="weq-vc-faceband">
                  <span className="weq-vc-faceband-tag">系统表情</span>
                  <div className="weq-vc-face-tiles">
                    {faces.map((face, rank) => (
                      <FaveFace
                        key={face.faceId}
                        face={face}
                        rank={rank}
                        size={FACE_TILE_SIZES[rank] ?? 46}
                      />
                    ))}
                  </div>
                </div>
              ) : null}
              {hasFaces && data.pic ? <span className="weq-vc-faves-sep" aria-hidden /> : null}
              {data.pic ? <FavePic pic={data.pic} /> : null}
            </div>
          </section>
        ) : null}

        <p className="weq-vc-mood weq-report-line" style={{ '--i': 5 } as CSSProperties}>
          {mood}
        </p>
      </div>
    </PageFrame>
  );
}

function FaveFace({
  face,
  rank,
  size,
}: {
  face: NonNullable<VoicePageData['faces'][number]>;
  rank: number;
  size: number;
}): ReactElement {
  return (
    <div className="weq-vc-face-tile" data-rank={rank}>
      <FaceEmoji
        element={{ faceId: face.faceId, faceText: face.name }}
        size={size}
        className="weq-vc-fave-face"
      />
      <p className="weq-vc-fave-name">{face.name}</p>
      <p className="weq-vc-fave-count">
        <b className="weq-number">{fmt(face.count)}</b> 次
      </p>
    </div>
  );
}

function FavePic({ pic }: { pic: VoicePicFavorite }): ReactElement {
  const [broken, setBroken] = useState(false);
  const params: Record<string, string | number> = { t: pic.sendTimeMs, name: pic.fileName };
  if (pic.fileToken) params.token = pic.fileToken;
  if (pic.md5) params.md5 = pic.md5;
  if (pic.originalUrl) params.orig = pic.originalUrl;
  // subType 1 的自定义表情按聊天同款「收到表情」路径寻址（Emoji/emoji-recv）。
  if (pic.subType === 1) params.recv = '1';
  const src = mediaUrl('pic', params);

  return (
    <div className="weq-vc-fave is-pic">
      <span className="weq-vc-fave-label">自定义表情</span>
      {broken ? (
        <span className="weq-vc-pic-broken" aria-hidden>
          <ImageOff size={24} strokeWidth={1.3} />
        </span>
      ) : (
        <img
          className="weq-vc-pic-img"
          src={src}
          alt="我最常发的自定义表情"
          draggable={false}
          onError={() => setBroken(true)}
        />
      )}
      <p className="weq-vc-fave-name">这张图，替你说了很多次话</p>
      <p className="weq-vc-fave-count">
        <b className="weq-number">{fmt(pic.count)}</b> 次
      </p>
    </div>
  );
}

/**
 * 背景词云：词语散在整页、各自慢慢漂。刻意不进任何图表组件——
 * 它只是「说过很多次的话」这层氛围底噪，主角永远是那句大词。
 */
function WordCloud({ words, active }: { words: VoiceWord[]; active: boolean }): ReactElement {
  const entries = useMemo(
    () =>
      words.slice(0, CLOUD_LIMIT).map((entry, index) => {
        const seed = hashWord(entry.word) + index * 17;
        const rand = mulberry32(seed);
        const max = Math.max(1, ...words.slice(0, CLOUD_LIMIT).map((w) => w.count));
        const rank = 1 - entry.count / max;
        const size = 16 + (1 - rank) * 20 + (entry.word.length <= 2 ? 5 : 0);
        return {
          word: entry.word,
          left: rand() * 88 + 6,
          top: rand() * 82 + 9,
          rotate: Math.round(rand() * 44 - 22),
          size: Math.min(48, size),
          duration: 7 + rand() * 8,
          delay: rand() * 6,
          opacity: 0.07 + rank * 0.11,
        };
      }),
    [words],
  );

  return (
    <div className="weq-vc-cloud" data-enter={active ? 'in' : 'out'} aria-hidden>
      {entries.map((entry, index) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: 词云布局由 seed 决定，词列表稳定不变形。
          key={`${entry.word}:${index}`}
          className="weq-vc-cloud-word"
          style={
            {
              '--wc-left': `${entry.left}%`,
              '--wc-top': `${entry.top}%`,
              '--wc-rot': `${entry.rotate}deg`,
              '--wc-size': `${Math.round(entry.size)}px`,
              '--wc-dur': `${entry.duration}s`,
              '--wc-delay': `${entry.delay}s`,
              '--wc-alpha': entry.opacity,
            } as CSSProperties
          }
        >
          {entry.word}
        </span>
      ))}
    </div>
  );
}

/** 字符串 → 稳定种子。 */
function hashWord(word: string): number {
  let hash = 2166136261;
  for (let i = 0; i < word.length; i++) {
    hash ^= word.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** 伪随机数生成器（mulberry32），词云布局只要确定、不要每次渲染乱跳。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
