import { useEffect, useState, type CSSProperties, type ReactElement, type ReactNode } from 'react';
import type { PokePageData } from '@weq/service';
import { REPORT_POKE_FIGURE_ID } from '@weq/service/report-assets';
import { isAllTimeYear, reportEraLabel } from '@weq/service/report-time';
import { resourceUrl } from '@renderer/lib/resourceUrl';
import { PageFrame, type ReportPageProps } from '../pageFrame';
import { Odometer } from '../Odometer';

function fmt(n: number): string {
  return new Intl.NumberFormat('zh-CN').format(n);
}

/**
 * 戳一戳 —— 一页只讲「隔着屏幕的那一下」。
 *
 * 版心是一次**对视**：左边是我戳出去的次数，右边是别人戳我的次数，中间立着一枚
 * 超大的「戳」字，四周套着一圈很慢的碰撞涟漪——左右两个数字被同一个动作连起来，
 * 不再是两组并列的统计。
 *
 * 下面一条**相向点阵**是这一页唯一的图表：上排点从左往右亮（我伸出去的手），
 * 下排点从右往左亮（伸向我的手），两排朝中间靠拢，在版面上真的「戳」到一起。
 * 这个形状与 @ 页的弧线、复读页的层叠字完全不同。
 */
export function PokePage({ page, data, active }: ReportPageProps<PokePageData>): ReactElement {
  const allTime = isAllTimeYear(data.year);
  const era = allTime ? '有记录以来' : `${data.year} 年`;
  const [drawn, setDrawn] = useState(false);

  useEffect(() => {
    if (!active) {
      setDrawn(false);
      return undefined;
    }
    const timer = window.setTimeout(() => setDrawn(true), 520);
    return () => window.clearTimeout(timer);
  }, [active]);

  const hero = data.pokeTotal >= data.pokeMeTotal ? ('out' as const) : ('in' as const);
  const mood =
    hero === 'out'
      ? data.pokeTop
        ? `最常被你戳到的是 ${data.pokeTop.name}——戳一戳什么都不用说，只是告诉对方「我在」。`
        : '你伸出去的手不多，但每一下都先越过了屏幕。'
      : data.pokeMeTop
        ? `最常戳你的是 ${data.pokeMeTop.name}——有人想你了，就先轻轻碰你一下。`
        : '被戳的次数不多，可每一次都是有人先想起你。';

  return (
    <PageFrame page={page} active={active} ghost="戳" tone="#a8503c">
      <div className="weq-poke">
        <header className="weq-poke-kicker weq-report-line" style={{ '--i': 1 } as CSSProperties}>
          <span>{reportEraLabel(data.year)} · 戳一戳</span>
          <span className="weq-poke-kicker-meta">
            我戳出去 <b className="weq-number">{fmt(data.pokeTotal)}</b> 次<i aria-hidden>/</i>
            被戳 <b className="weq-number">{fmt(data.pokeMeTotal)}</b> 次
          </span>
        </header>

        <section className="weq-poke-hero weq-report-line" style={{ '--i': 2 } as CSSProperties}>
          <p className="weq-poke-lede">{era}，隔着屏幕的那一下——</p>
          <div className="weq-poke-main">
            <div className={`weq-poke-side is-out${hero === 'out' ? ' is-hero' : ''}`}>
              <span className="weq-poke-side-num">
                <Odometer
                  value={data.pokeTotal}
                  active={active}
                  className="weq-poke-num"
                  durationMs={1600}
                />
              </span>
              <span className="weq-poke-side-label">我戳出去</span>
              <span className="weq-poke-side-sub">
                {data.pokeTop ? (
                  <>
                    最常戳 <em>{data.pokeTop.name}</em>
                    <i aria-hidden> · </i>
                    <b className="weq-number">{fmt(data.pokeTop.count)}</b> 次
                  </>
                ) : (
                  <>这一年，你的手指还没养成戳人的习惯</>
                )}
              </span>
            </div>

            <div className="weq-poke-glyph-wrap" aria-hidden>
              <PokeFigure />
            </div>

            <div className={`weq-poke-side is-in${hero === 'in' ? ' is-hero' : ''}`}>
              <span className="weq-poke-side-num">
                <Odometer
                  value={data.pokeMeTotal}
                  active={active}
                  className="weq-poke-num"
                  durationMs={1600}
                />
              </span>
              <span className="weq-poke-side-label">别人戳我</span>
              <span className="weq-poke-side-sub">
                {data.pokeMeTop ? (
                  <>
                    最常戳我 <em>{data.pokeMeTop.name}</em>
                    <i aria-hidden> · </i>
                    <b className="weq-number">{fmt(data.pokeMeTop.count)}</b> 次
                  </>
                ) : (
                  <>还没有人隔着屏幕先碰你一下</>
                )}
              </span>
            </div>
          </div>
        </section>

        <PokeLanes mine={data.pokeTotal} theirs={data.pokeMeTotal} drawn={drawn} />

        <p className="weq-poke-mood weq-report-line" style={{ '--i': 6 } as CSSProperties}>
          {mood}
        </p>
      </div>
    </PageFrame>
  );
}

/**
 * 版心那枚「戳」—— 用 `resources/pokeemoji` 的戳一戳表情贴图（APNG，Chromium 里
 * 自己就在动），比一个静止的汉字更贴题。贴图缺失/解码失败时退回「戳」字形的
 * 排印版，页面不会因此破版。
 */
function PokeFigure(): ReactElement {
  const [broken, setBroken] = useState(false);
  if (broken) return <span className="weq-poke-glyph">戳</span>;
  return (
    <img
      className="weq-poke-figure"
      src={resourceUrl('pokeemoji', `${REPORT_POKE_FIGURE_ID}.png`)}
      alt=""
      draggable={false}
      onError={() => setBroken(true)}
    />
  );
}

/**
 * 相向点阵：两条「手」的航道隔着中线对望 —— 左边是我伸出去的，右边是伸向我的，
 * 两边的点都朝中间那道发丝线亮起，像隔着屏幕碰上。
 */
function PokeLanes({
  mine,
  theirs,
  drawn,
}: {
  mine: number;
  theirs: number;
  drawn: boolean;
}): ReactElement {
  const MAX = 24;
  return (
    <section className="weq-poke-stream weq-report-line" style={{ '--i': 4 } as CSSProperties}>
      <div className="weq-poke-lanes">
        <Lane
          count={Math.min(MAX, mine)}
          overflow={Math.max(0, mine - MAX)}
          side="out"
          drawn={drawn}
          label={
            <>
              我伸出去的手 <b className="weq-number">{fmt(mine)}</b>
            </>
          }
        />
        <span className="weq-poke-spark" aria-hidden>
          <i />
        </span>
        <Lane
          count={Math.min(MAX, theirs)}
          overflow={Math.max(0, theirs - MAX)}
          side="in"
          drawn={drawn}
          label={
            <>
              <b className="weq-number">{fmt(theirs)}</b> 伸向我的手
            </>
          }
        />
      </div>
      <p className="weq-poke-lanes-note">每一点 = 一次戳一戳</p>
    </section>
  );
}

function Lane({
  count,
  overflow,
  side,
  drawn,
  label,
}: {
  count: number;
  overflow: number;
  side: 'out' | 'in';
  drawn: boolean;
  label: ReactNode;
}): ReactElement {
  // 越靠近中线的点越先亮：延时按「距中线的距离」递增，两束点从中间往外铺开。
  const distanceFromCenter = (index: number): number =>
    side === 'out' ? count - 1 - index : index;
  return (
    <div className={`weq-poke-lane is-${side}`} data-drawn={drawn ? 'yes' : 'no'}>
      <span className="weq-poke-lane-label">{label}</span>
      <span className="weq-poke-lane-dots">
        {Array.from({ length: count }, (_, index) => (
          <i
            // biome-ignore lint/suspicious/noArrayIndexKey: 点按距中线的位置渲染，位置即稳定键。
            key={`${side}-${index}`}
            className="weq-poke-dot"
            style={{ '--d': distanceFromCenter(index) } as CSSProperties}
          />
        ))}
        {count === 0 ? <i className="weq-poke-dot is-empty" /> : null}
        {overflow > 0 ? <b className="weq-poke-dot-more">+{fmt(overflow)}</b> : null}
      </span>
    </div>
  );
}
