import { useMemo, type CSSProperties, type ReactElement } from 'react';
import type { HomeGroupTop, HomePageData, HomeTopicWord } from '@weq/service';
import { isAllTimeYear, reportEraLabel } from '@weq/service/report-time';
import { PageFrame, type ReportPageProps } from '../pageFrame';
import { Odometer } from '../Odometer';

function fmt(n: number): string {
  return new Intl.NumberFormat('zh-CN').format(n);
}

/** 话题行里最多排几位 —— 再多就不是「话题」而是标签云了。 */
const TOPIC_SHOW = 5;
/** 背景词云最多散几颗 —— 只负责氛围，数量一多就吃掉群名的视线。 */
const CLOUD_LIMIT = 17;
/** 按名次递减的字号：第一个词最响，后面的是回声。 */
const TOPIC_SIZES = [40, 27, 24, 21, 20];

/**
 * 我的主场 —— 一页只有一个答案：你把最多的话，留给了哪个群。
 *
 * 它不做排行、不画饼图。群名是这一页的巨人，消息数压着它落地 —— 数字有多大，
 * 归属就有多重。等级与头衔只是页底的签名，话题词是这一整年的「背景音」：
 * 高频词先散成很低饱和的底噪，再在页脚抽出五颗变成一句可读的话。
 */
export function HomePage({ page, data, active }: ReportPageProps<HomePageData>): ReactElement {
  const allTime = isAllTimeYear(data.year);
  const top = data.top;
  const topics = top?.topics ?? [];
  const share =
    top && data.groupSentTotal > 0 ? Math.round((top.sentCount / data.groupSentTotal) * 100) : 0;

  return (
    <PageFrame page={page} active={active} ghost="群" tone="#a97b2e">
      <div className="weq-home" data-has-top={top ? 'yes' : 'no'}>
        {top && topics.length > 0 ? <TopicCloud words={topics} active={active} /> : null}

        <header className="weq-home-kicker weq-report-line" style={{ '--i': 1 } as CSSProperties}>
          <span>{reportEraLabel(data.year)} · 我的主场</span>
          <span className="weq-home-kicker-meta">
            <b className="weq-number">{fmt(data.activeGroupCount)}</b> 个群说过话
            <i aria-hidden>/</i>
            <b className="weq-number">{fmt(data.groupSentTotal)}</b> 条群消息
          </span>
        </header>

        {top ? (
          <>
            <section className="weq-home-hero">
              <p className="weq-home-lede weq-report-line" style={{ '--i': 2 } as CSSProperties}>
                {allTime ? '有记录以来' : `${data.year} 年`}，你在群聊里说得最多的地方，是——
              </p>
              <h2
                className={`weq-home-name ${nameSize(top.groupName)}`}
                style={{ '--i': 3 } as CSSProperties}
              >
                {top.groupName}
              </h2>
              <p
                className="weq-home-countline weq-report-line"
                style={{ '--i': 4 } as CSSProperties}
              >
                <Odometer
                  value={top.sentCount}
                  active={active}
                  className="weq-home-count"
                  durationMs={1800}
                />
                <span className="weq-home-unit" aria-hidden>
                  <b>条</b>
                  <i>消息</i>
                </span>
              </p>
              <p className="weq-home-share weq-report-line" style={{ '--i': 5 } as CSSProperties}>
                <i aria-hidden />
                {share >= 95 ? '你的群消息，几乎都落在这里' : `占你全部群消息的 ${share}%`}
                <i aria-hidden />
              </p>
            </section>

            <Signature top={top} step={6} />

            {topics.length > 0 ? (
              <section
                className="weq-home-topics weq-report-line"
                style={{ '--i': 7 } as CSSProperties}
              >
                <p className="weq-home-topics-in">这一年，这个群里的话题集中在</p>
                <p className="weq-home-topics-words">
                  {topics.slice(0, TOPIC_SHOW).map((topic, rank) => (
                    <span
                      key={topic.word}
                      className="weq-home-topic-word"
                      data-rank={rank}
                      style={
                        {
                          '--t': rank,
                          '--sz': topicFont(topic.word, rank),
                        } as CSSProperties
                      }
                    >
                      {topic.word}
                    </span>
                  ))}
                </p>
              </section>
            ) : null}

            <p className="weq-home-mood weq-report-line" style={{ '--i': 8 } as CSSProperties}>
              {fmt(top.sentCount)} 次开口都有回声——热闹不是噪音，是总有人愿意接住你。
            </p>
          </>
        ) : (
          <p className="weq-home-empty">群聊记录还在，但本地没有足够的群资料，讲不出这座主场。</p>
        )}
      </div>
    </PageFrame>
  );
}

/** 词太长时按宽度收缩字号，别让一颗长词撑破话题行。 */
function topicFont(word: string, rank: number): number {
  const base = TOPIC_SIZES[rank] ?? 18;
  const width = [...word].reduce((sum, char) => sum + (/\p{Script=Han}/u.test(char) ? 1 : 0.58), 0);
  return width > 9 ? Math.max(17, Math.round(base * 0.56)) : base;
}

/** 群名越长字越小，始终只占一行 —— 巨字是冲击力，不是换行负担。 */
function nameSize(name: string): string {
  const width = [...name].reduce((sum, char) => sum + (/\p{Script=Han}/u.test(char) ? 1 : 0.62), 0);
  if (width > 11) return 'is-xl';
  if (width > 7) return 'is-long';
  return '';
}

/** 群等级 / 群头衔 / 群规模 —— 三枚小签名，不是三张卡片。 */
function Signature({ top, step }: { top: HomeGroupTop; step: number }): ReactElement | null {
  const items: Array<{ label: string; value: string; note: string }> = [];
  if (top.memberLevel > 0) {
    items.push({
      label: '群等级',
      value: `LV.${top.memberLevel}`,
      note: top.levelName,
    });
  }
  if (top.customTitle) {
    items.push({ label: '群头衔', value: top.customTitle, note: '' });
  } else if (top.role === 'owner' || top.role === 'admin') {
    items.push({
      label: '群头衔',
      value: top.role === 'owner' ? '群主' : '管理员',
      note: '',
    });
  }
  if (top.memberCount > 0) {
    items.push({ label: '群成员', value: fmt(top.memberCount), note: '人' });
  }
  if (items.length === 0) return null;

  return (
    <p className="weq-home-sig weq-report-line" style={{ '--i': step } as CSSProperties}>
      {items.map((item, index) => (
        <span className="weq-home-sig-item" key={item.label}>
          {index > 0 ? <s aria-hidden /> : null}
          <i>{item.label}</i>
          <b>{item.value}</b>
          {item.note ? <em>{item.note}</em> : null}
        </span>
      ))}
    </p>
  );
}

/**
 * 背景话题云：冠军群的高频词散在整页、各自慢慢漂，低饱和不出声——
 * 它们是这一整年的底噪，主角永远是群名和那个巨数。
 */
function TopicCloud({ words, active }: { words: HomeTopicWord[]; active: boolean }): ReactElement {
  const entries = useMemo(
    () =>
      words.slice(0, CLOUD_LIMIT).map((entry, index) => {
        const seed = hashWord(entry.word) + index * 19;
        const rand = mulberry32(seed);
        const max = Math.max(1, ...words.slice(0, CLOUD_LIMIT).map((w) => w.count));
        const rank = 1 - entry.count / max;
        const wordWidth = [...entry.word].reduce(
          (sum, char) => sum + (/\p{Script=Han}/u.test(char) ? 1 : 0.58),
          0,
        );
        const shrink = wordWidth > 7 ? Math.max(0.4, 7 / wordWidth) : 1;
        const size = (15 + (1 - rank) * 18 + (entry.word.length <= 2 ? 4 : 0)) * shrink;
        return {
          word: entry.word,
          left: rand() * 88 + 6,
          top: rand() * 84 + 8,
          rotate: Math.round(rand() * 40 - 20),
          size: Math.min(44, size),
          duration: 8 + rand() * 9,
          delay: rand() * 6,
          opacity: 0.055 + rank * 0.1,
        };
      }),
    [words],
  );

  return (
    <div className="weq-home-cloud" data-enter={active ? 'in' : 'out'} aria-hidden>
      {entries.map((entry, index) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: 词云布局由 seed 决定，词列表稳定不变形。
          key={`${entry.word}:${index}`}
          className="weq-home-cloud-word"
          style={
            {
              '--hc-left': `${entry.left}%`,
              '--hc-top': `${entry.top}%`,
              '--hc-rot': `${entry.rotate}deg`,
              '--hc-size': `${Math.round(entry.size)}px`,
              '--hc-dur': `${entry.duration}s`,
              '--hc-delay': `${entry.delay}s`,
              '--hc-alpha': entry.opacity,
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
