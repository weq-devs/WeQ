import { useEffect, useMemo, useState, type CSSProperties, type ReactElement } from 'react';
import type { EchoPageData } from '@weq/service';
import { isAllTimeYear, reportEraLabel } from '@weq/service/report-time';
import { PageFrame, type ReportPageProps } from '../pageFrame';
import { Odometer, usePrefersReducedMotion } from '../Odometer';

function fmt(n: number): string {
  return new Intl.NumberFormat('zh-CN').format(n);
}

/** 层叠回声最多画几行；再多的重复收成一句小注。 */
const ECHO_LINES = 6;
/** 过长的一句在页面上截断（签名匹配始终用完整正文，这里只管排印）。 */
const ECHO_CLIP = 18;

/**
 * 复读 —— 一页只讲「齐声」。
 *
 * 这一页的图表不是柱也不是线，而是**同一句话被叠起来**：巨字是第一声，往下每
 * 一行都更小、更淡，像回声一层层退远——它就是「复读」本身。页面上方的主句取
 * 「我参与过的最长一轮」（如果没有，退到全群最长的一轮），因为最值得记住的不是
 * 群里最长的那次热闹，而是**我也在里面**的那一次。
 *
 * 进场时几行字从上往下依次落下，像群里一个人接一个人地跟上。
 */
export function EchoPage({ page, data, active }: ReportPageProps<EchoPageData>): ReactElement {
  const allTime = isAllTimeYear(data.year);
  const era = allTime ? '有记录以来' : `${data.year} 年`;
  const [drawn, setDrawn] = useState(false);
  const reduce = usePrefersReducedMotion();

  useEffect(() => {
    if (!active) {
      setDrawn(false);
      return undefined;
    }
    const timer = window.setTimeout(() => setDrawn(true), 460);
    return () => window.clearTimeout(timer);
  }, [active]);

  // 主体优先「我参与过的最长一轮」——个人的那一句才值得顶到版心。
  const featured = data.mineLongest ?? data.longest;
  const other = data.mineLongest && data.longest ? data.longest : null;
  const mineFeatured = data.mineLongest != null;

  const lede = useMemo(() => {
    if (!featured) return `${era}，你们还没有聊到齐声。`;
    if (mineFeatured) {
      return `${era}，有一句话你跟着接了 ${fmt(featured.count)} 次——`;
    }
    return `${era}，${featured.groupName}里有一句话被接了 ${fmt(featured.count)} 次——`;
  }, [era, featured, mineFeatured]);

  const mood = featured
    ? mineFeatured
      ? `一句话被那么多人接住，就不再只是一个人的了——那一次的齐声里，有你。`
      : `你没有跟上那一次，但群里那么多人在同一秒说了同一句话——热闹是会传染的。`
    : '这一年没有足够长的齐声——下一条被大家跟上的话，可能就由你开头。';

  return (
    <PageFrame page={page} active={active} ghost="齐" tone="#2f7a7a">
      <div className="weq-echo">
        <header className="weq-echo-kicker weq-report-line" style={{ '--i': 1 } as CSSProperties}>
          <span>{reportEraLabel(data.year)} · 复读</span>
          <span className="weq-echo-kicker-meta">
            <b className="weq-number">{fmt(data.runs)}</b> 场齐声
            <i aria-hidden>/</i>
            <b className="weq-number">{fmt(data.messages)}</b> 条重复
          </span>
        </header>

        <section className="weq-echo-hero weq-report-line" style={{ '--i': 2 } as CSSProperties}>
          <p className="weq-echo-lede">{lede}</p>
          {featured ? (
            <EchoStack
              phrase={featured.text}
              count={featured.count}
              groupName={featured.groupName}
              mine={mineFeatured}
              drawn={drawn}
              reduce={reduce}
            />
          ) : (
            <p className="weq-echo-empty">这一年，群里还没唱到同一句。</p>
          )}
        </section>

        <dl className="weq-echo-band weq-report-line" style={{ '--i': 6 } as CSSProperties}>
          <BandCell
            label="我跟上过"
            value={fmt(data.participated)}
            unit="场"
            note={data.participated > 0 ? '至少一次，我在人群里' : '这一年你没接上去'}
          />
          <BandCell
            label="全群齐声"
            value={fmt(data.runs)}
            unit="场"
            note={`被重复的消息共 ${fmt(data.messages)} 条`}
          />
          <BandCell
            label="我参与的最长一轮"
            value={fmt(data.mineLongest?.count ?? 0)}
            unit="条"
            note={data.mineLongest?.groupName ?? '还没有那一轮'}
          />
          <BandCell
            label="全群最长一轮"
            value={fmt(other?.count ?? data.longest?.count ?? 0)}
            unit="条"
            note={other?.groupName ?? data.longest?.groupName ?? '还没有那一轮'}
          />
        </dl>

        <p className="weq-echo-mood weq-report-line" style={{ '--i': 7 } as CSSProperties}>
          {mood}
        </p>
      </div>
    </PageFrame>
  );
}

/**
 * 层叠回声：第一行是巨字，往下每行更小更淡。行数按「这一轮有多少条」取，
 * 超过上限的重复收成页脚一句小注——不假装把 200 条都画出来。
 */
function EchoStack({
  phrase,
  count,
  groupName,
  mine,
  drawn,
  reduce,
}: {
  phrase: string;
  count: number;
  groupName: string;
  mine: boolean;
  drawn: boolean;
  reduce: boolean;
}): ReactElement {
  const clipped = phrase.length > ECHO_CLIP ? `${phrase.slice(0, ECHO_CLIP)}…` : phrase;
  const lines = Math.max(2, Math.min(ECHO_LINES, count));
  return (
    <div
      className={`weq-echo-stack${mine ? ' is-mine' : ''}`}
      data-drawn={drawn ? 'yes' : 'no'}
      data-reduce={reduce ? 'yes' : 'no'}
    >
      <p className="weq-echo-stack-where">
        在「<em>{groupName}</em>」里
        {mine ? <>，你在的那一轮，</> : <>，</>}
      </p>
      <div className="weq-echo-lines" aria-hidden>
        {Array.from({ length: lines }, (_, index) => (
          <p
            // biome-ignore lint/suspicious/noArrayIndexKey: 回声行是同内容的重复序号，位置即稳定键。
            key={index}
            className="weq-echo-line"
            style={{ '--e': index } as CSSProperties}
          >
            「{clipped}」
          </p>
        ))}
      </div>
      <p className="weq-echo-stack-count">
        <span>这句话连着响了</span>
        <Odometer value={count} active={drawn} className="weq-echo-num" durationMs={1500} />
        <span>次</span>
      </p>
      {count > lines ? (
        <p className="weq-echo-stack-more">… 后面的还没停，同一条声音继续往下接</p>
      ) : null}
    </div>
  );
}

function BandCell({
  label,
  value,
  unit,
  note,
}: {
  label: string;
  value: string;
  unit: string;
  note: string;
}): ReactElement {
  return (
    <div className="weq-echo-band-cell">
      <dt>{label}</dt>
      <dd>
        <span className="weq-number">{value}</span>
        <i>{unit}</i>
      </dd>
      <p className="weq-echo-band-note">{note}</p>
    </div>
  );
}
