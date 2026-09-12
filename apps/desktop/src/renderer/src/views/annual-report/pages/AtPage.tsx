import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from 'react';
import type { AtPageData } from '@weq/service';
import { isAllTimeYear, reportEraLabel } from '@weq/service/report-time';
import { PageFrame, type ReportPageProps } from '../pageFrame';
import { Odometer, usePrefersReducedMotion } from '../Odometer';

function fmt(n: number): string {
  return new Intl.NumberFormat('zh-CN').format(n);
}

/**
 * @ 与被 @ —— 一页只讲「名字」。
 *
 * 主角是一枚 **超大的 @**：它不是装饰，是这一页的全部动作——把某个名字从人群里
 * 单独拎出来。数字（我喊出去多少次）与它并排，下面一条**双弧喊话线**是这一页唯一
 * 的图表：上面一道弧朝外扩散（我喊出去的名字），下面一道弧朝内收拢（喊我的名字），
 * 弧上的每一枚刻度点是一位不同的人，冠军那枚更大更亮。两道弧朝相反方向张开，
 * 在版面上就是一次「喊」和一次「被喊」，别的页没有这道形状。
 *
 * 弧在进场时从一端画到另一端，刻度点随后逐枚亮起；翻走再翻回会重播。
 */
export function AtPage({ page, data, active }: ReportPageProps<AtPageData>): ReactElement {
  const allTime = isAllTimeYear(data.year);
  const era = allTime ? '有记录以来' : `${data.year} 年`;
  const [drawn, setDrawn] = useState(false);
  const reduce = usePrefersReducedMotion();

  useEffect(() => {
    if (!active) {
      setDrawn(false);
      return undefined;
    }
    // 与其它页一致：先让巨字自己站定，再让图表动起来（避免同时抢注意力）。
    const timer = window.setTimeout(() => setDrawn(true), 520);
    return () => window.clearTimeout(timer);
  }, [active]);

  const mineFirst = data.atTotal >= data.atMeTotal;
  const heroCount = mineFirst ? data.atTotal : data.atMeTotal;
  const heroUnit = '次';
  const heroLabel = mineFirst ? '我 @ 过别人' : '我被人点名过';
  const heroNote = mineFirst
    ? data.atTop
      ? `喊得最响的是 ${data.atTop.name}——名字被念出来，才不算淹没在人群里。`
      : '你喊得不多，但每一声都有人听见。'
    : data.atMeTop
      ? `最多发生在「${data.atMeTop.groupName}」——被点名，是被人想起的最短路径。`
      : '名字被念起的次数不多，可每一次都有人记得你。';

  return (
    <PageFrame page={page} active={active} ghost="@" tone="#3d5a99">
      <div className="weq-call">
        <header className="weq-call-kicker weq-report-line" style={{ '--i': 1 } as CSSProperties}>
          <span>{reportEraLabel(data.year)} · @ 与被 @</span>
          <span className="weq-call-kicker-meta">
            <b className="weq-number">{fmt(data.atPeople)}</b> 个名字喊出去
            <i aria-hidden>/</i>
            <b className="weq-number">{fmt(data.atMePeople)}</b> 个名字喊回来
          </span>
        </header>

        <section className="weq-call-hero weq-report-line" style={{ '--i': 2 } as CSSProperties}>
          <p className="weq-call-lede">{era}，你在人群里点过的名字——</p>
          <div className="weq-call-main">
            <span className="weq-call-glyph" aria-hidden>
              @
            </span>
            <span className="weq-call-divider" aria-hidden />
            <span className="weq-call-count">
              <span className="weq-call-countline">
                <Odometer
                  value={heroCount}
                  active={active}
                  className="weq-call-num"
                  durationMs={1600}
                />
                <i className="weq-call-unit">{heroUnit}</i>
              </span>
              <span className="weq-call-count-label">{heroLabel}</span>
            </span>
          </div>
        </section>

        <CallArcs
          mine={data.atTotal}
          minePeople={data.atPeople}
          theirs={data.atMeTotal}
          theirsPeople={data.atMePeople}
          mineName={data.atTop?.name ?? null}
          drawn={drawn}
          reduce={reduce}
        />

        <dl className="weq-call-facts weq-report-line" style={{ '--i': 6 } as CSSProperties}>
          <Fact
            label="喊出去"
            main={
              <>
                <b className="weq-number">{fmt(data.atTotal)}</b> 次，落在
                <em> {fmt(data.atPeople)}</em> 个名字上
              </>
            }
            sub={
              data.atTop ? (
                <>
                  最常被点到：<em>{data.atTop.name}</em>
                  <i aria-hidden> · </i>
                  <b className="weq-number">{fmt(data.atTop.count)}</b> 次
                </>
              ) : (
                <>这一年，你还没把谁的名字单独拎出来过。</>
              )
            }
          />
          <Fact
            label="喊回来"
            main={
              <>
                <b className="weq-number">{fmt(data.atMeTotal)}</b> 次，来自
                <em> {fmt(data.atMePeople)}</em> 个人
              </>
            }
            sub={
              data.atMeTop ? (
                <>
                  最多的一声在 <em>{data.atMeTop.groupName}</em>
                  <i aria-hidden> · </i>
                  <b className="weq-number">{fmt(data.atMeTop.count)}</b> 次
                </>
              ) : (
                <>还没有哪个群反复喊你的名字。</>
              )
            }
          />
        </dl>

        <p className="weq-call-mood weq-report-line" style={{ '--i': 7 } as CSSProperties}>
          {heroNote}
        </p>
      </div>
    </PageFrame>
  );
}

/** 页底两行事实：句子而不是卡片，数字嵌在句子里。 */
function Fact({
  label,
  main,
  sub,
}: {
  label: string;
  main: ReactNode;
  sub: ReactNode;
}): ReactElement {
  return (
    <div className="weq-call-fact">
      <dt className="weq-call-fact-label">{label}</dt>
      <dd className="weq-call-fact-body">
        <span className="weq-call-fact-main">{main}</span>
        <span className="weq-call-fact-sub">{sub}</span>
      </dd>
    </div>
  );
}

/** 三次贝塞尔在 t 处的点 —— 刻度点沿弧铺开用。 */
function cubicPoint(
  t: number,
  p0: readonly [number, number],
  p1: readonly [number, number],
  p2: readonly [number, number],
  p3: readonly [number, number],
): readonly [number, number] {
  const u = 1 - t;
  const x = u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0];
  const y = u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1];
  return [x, y];
}

/**
 * 双弧喊话线：上弧朝外（我 @ 出去），下弧朝内（别人 @ 我）。
 *
 * 弧上的刻度点 = 不同的人（最多画 30 枚，其余折成一行小注），冠军那枚更大更亮。
 * 弧在进场时用 `pathLength` 归一化的 dash 从一端画到另一端；刻度点随后按序亮起。
 */
function CallArcs({
  mine,
  minePeople,
  theirs,
  theirsPeople,
  mineName,
  drawn,
  reduce,
}: {
  mine: number;
  minePeople: number;
  theirs: number;
  theirsPeople: number;
  mineName: string | null;
  drawn: boolean;
  reduce: boolean;
}): ReactElement {
  // 宽幅 viewBox：SVG 宽度铺满画幅、高度按比例自适应，刻度点因此保持正圆。
  const W = 1120;
  const H = 176;
  const MAX_DOTS = 30;

  const top = useMemo(
    () =>
      [
        [80, 74],
        [360, 14],
        [760, 14],
        [1040, 74],
      ] as const,
    [],
  );
  const bottom = useMemo(
    () =>
      [
        [80, 102],
        [360, 162],
        [760, 162],
        [1040, 102],
      ] as const,
    [],
  );

  const mineDots = Math.min(MAX_DOTS, minePeople);
  const theirDots = Math.min(MAX_DOTS, theirsPeople);
  const mineHidden = Math.max(0, minePeople - mineDots);
  const theirHidden = Math.max(0, theirsPeople - theirDots);

  // 点的铺开留出两端边距，别把弧端点也当成一枚人。
  const spread = (index: number, count: number): number =>
    count <= 1 ? 0.5 : 0.08 + (index / (count - 1)) * 0.84;

  const mineDotPoints = Array.from({ length: mineDots }, (_, i) =>
    cubicPoint(spread(i, mineDots), top[0], top[1], top[2], top[3]),
  );
  const theirDotPoints = Array.from({ length: theirDots }, (_, i) =>
    cubicPoint(1 - spread(i, theirDots), bottom[0], bottom[1], bottom[2], bottom[3]),
  );

  return (
    <section className="weq-call-arcs weq-report-line" style={{ '--i': 4 } as CSSProperties}>
      <div className="weq-call-arcs-head">
        <span className="weq-call-arcs-name is-mine">我喊出去</span>
        <span className="weq-call-arcs-name is-theirs">喊我的名字</span>
      </div>
      <svg
        className="weq-call-arcs-svg"
        data-drawn={drawn ? 'yes' : 'no'}
        data-reduce={reduce ? 'yes' : 'no'}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`我 @ 过 ${mine} 次、共 ${minePeople} 个名字；别人 @ 我 ${theirs} 次、共 ${theirsPeople} 个名字`}
        preserveAspectRatio="xMidYMid meet"
      >
        <defs>
          <linearGradient id="weq-call-mine" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" className="weq-call-grad-fade" />
            <stop offset="22%" className="weq-call-grad-solid" />
            <stop offset="78%" className="weq-call-grad-solid" />
            <stop offset="100%" className="weq-call-grad-fade" />
          </linearGradient>
        </defs>

        {/* 中线：两条弧的「我」 */}
        <line className="weq-call-arcs-axis" x1="48" y1={H / 2} x2={W - 48} y2={H / 2} />

        <path
          className="weq-call-arc is-mine"
          pathLength={1}
          strokeDasharray="1"
          d={`M ${top[0][0]} ${top[0][1]} C ${top[1][0]} ${top[1][1]}, ${top[2][0]} ${top[2][1]}, ${top[3][0]} ${top[3][1]}`}
        />
        <path
          className="weq-call-arc is-theirs"
          pathLength={1}
          strokeDasharray="1"
          d={`M ${bottom[0][0]} ${bottom[0][1]} C ${bottom[1][0]} ${bottom[1][1]}, ${bottom[2][0]} ${bottom[2][1]}, ${bottom[3][0]} ${bottom[3][1]}`}
        />

        {mineDotPoints.map((point, index) => (
          <circle
            // biome-ignore lint/suspicious/noArrayIndexKey: 刻度点按弧上位置渲染，位置即稳定键。
            key={`mine-${index}`}
            className={`weq-call-dot is-mine${index === 0 ? ' is-champ' : ''}`}
            cx={point[0]}
            cy={point[1]}
            r={index === 0 ? 4.4 : 2.6}
            style={{ '--d': index } as CSSProperties}
          />
        ))}
        {theirDotPoints.map((point, index) => (
          <circle
            // biome-ignore lint/suspicious/noArrayIndexKey: 刻度点按弧上位置渲染，位置即稳定键。
            key={`their-${index}`}
            className={`weq-call-dot is-theirs${index === 0 ? ' is-champ' : ''}`}
            cx={point[0]}
            cy={point[1]}
            r={index === 0 ? 4.4 : 2.6}
            style={{ '--d': index } as CSSProperties}
          />
        ))}
      </svg>
      <div className="weq-call-arcs-foot">
        <span>
          每一点 = 一个名字
          {mineHidden > 0 ? `，另有 ${fmt(mineHidden)} 个` : ''}
          {mineName ? (
            <>
              <i aria-hidden> · </i>最常喊 <em>{mineName}</em>
            </>
          ) : null}
        </span>
        <span>
          每一点 = 一个喊过你的人
          {theirHidden > 0 ? `，另有 ${fmt(theirHidden)} 个` : ''}
        </span>
      </div>
    </section>
  );
}
