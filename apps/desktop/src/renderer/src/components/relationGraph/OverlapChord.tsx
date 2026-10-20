/**
 * 群成员重合 · 和弦图。
 *
 * 外圈每个弧段是一个群，弧段之间连线的粗细 / 浓淡 = 两个群的共同成员数。数据来自
 * {@link buildOverlapModel}（与力图的群模式同一份 `groupCodes`，不重复扫库）。
 *
 * 交互刻意保持「看图」而不是「跳转」：
 *  - 悬停弧段高亮它的所有连线，并在右侧列出交集最多的群；
 *  - 点击弧段固定选中，再点一次取消；
 *  - 点击某条交集（列表行 / 中心卡片上的群）打开共同成员卡片。
 *
 * 面积不代表人数：弧段长度按 √群规模 分配，避免一个几千人大群吃掉整圈。
 */

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { OverlapGroup, OverlapModel } from './graphModel';
import type { OverlapPairSelection } from './OverlapPairCard';

const MIN_ARC_LABEL = 0.11;
const PAD = 46;

interface Arc {
  group: OverlapGroup;
  a0: number;
  a1: number;
  mid: number;
}

function arcPath(cx: number, cy: number, rOuter: number, rInner: number, a0: number, a1: number) {
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const x0 = cx + Math.cos(a0) * rOuter;
  const y0 = cy + Math.sin(a0) * rOuter;
  const x1 = cx + Math.cos(a1) * rOuter;
  const y1 = cy + Math.sin(a1) * rOuter;
  const x2 = cx + Math.cos(a1) * rInner;
  const y2 = cy + Math.sin(a1) * rInner;
  const x3 = cx + Math.cos(a0) * rInner;
  const y3 = cy + Math.sin(a0) * rInner;
  return `M ${x0} ${y0} A ${rOuter} ${rOuter} 0 ${large} 1 ${x1} ${y1} L ${x2} ${y2} A ${rInner} ${rInner} 0 ${large} 0 ${x3} ${y3} Z`;
}

/** 把权重归一化到 0–1（对数压缩，极少数超强群对不会把其它线压成一条）。 */
function weightT(weight: number, max: number): number {
  if (weight <= 0) return 0;
  return Math.min(1, Math.log1p(weight) / Math.log1p(Math.max(1, max)));
}

export function OverlapChord({
  model,
  showAvatars,
  direction,
  onOpenPair,
}: {
  model: OverlapModel;
  showAvatars: boolean;
  direction: 'large' | 'small';
  onOpenPair: (selection: OverlapPairSelection) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 760, h: 560 });
  const [hovered, setHovered] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number; code: string } | null>(null);
  const uid = useId().replace(/:/g, '');

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      setSize({ w: Math.max(320, rect.width), h: Math.max(280, rect.height) });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    // 换数据 / 换阈值后，原来选中的群可能已经不在图里。
    if (picked && !model.groups.some((g) => g.code === picked)) setPicked(null);
  }, [model, picked]);

  const focus = hovered ?? picked;
  const cx = size.w / 2;
  const cy = size.h / 2;
  const rOuter = Math.max(90, Math.min(size.w, size.h) / 2 - PAD);
  const rInner = Math.max(60, rOuter - (showAvatars ? 50 : 34));

  const arcs = useMemo<Arc[]>(() => {
    const groups = model.groups;
    if (groups.length === 0) return [];
    // 只有一个群时不画整圈（那样就像个甜甜圈），留出缺口更像和弦图。
    const weights = groups.map((g) => Math.sqrt(g.poolSize) + 2);
    const total = weights.reduce((sum, value) => sum + value, 0);
    const gap = groups.length > 1 ? Math.min(0.012, 0.35 / groups.length) : 0;
    const usable = Math.PI * 2 - gap * groups.length;
    let cursor = -Math.PI / 2;
    return groups.map((group, index) => {
      const span = ((weights[index] ?? 0) / total) * usable;
      const arc = { group, a0: cursor, a1: cursor + span, mid: cursor + span / 2 };
      cursor += span + gap;
      return arc;
    });
  }, [model]);

  const byCode = useMemo(() => new Map(arcs.map((arc) => [arc.group.code, arc])), [arcs]);

  /**
   * 真正的「和弦」：每对群的连线在两端各占一段子弧（宽度按共同人数分配），
   * 用两条弧 + 两条直边围成一条填充带。这样线宽本身就在读数，而不是所有线
   * 都从圆心伸出来糊成一团。
   */
  const links = useMemo(() => {
    const chordR = rInner * 0.82;
    const pad = 0.004;
    /*
     * 大重叠：只画有共同成员的群对（线越粗越重合）。
     * 小重叠：恰好相反 —— 画「几乎不重合 / 完全没交集」的群对，这才是要看的。
     * 0 人重合没有宽度，用一条固定细带表示，让「这两个群真的没关系」看得见。
     */
    const activePairs = model.pairs.filter((pair) => {
      if (!byCode.has(pair.a) || !byCode.has(pair.b)) return false;
      // 小重叠模式下 buildOverlapModel 已把 0 重合的群对补齐进 pairs。
      return direction === 'small' ? true : pair.weight > 0;
    });

    // 每个群挂着的群对，按「另一端在圆上的角度」排一下，避免连线互相穿。
    const incident = new Map<string, typeof activePairs>();
    for (const arc of arcs) incident.set(arc.group.code, []);
    for (const pair of activePairs) {
      incident.get(pair.a)?.push(pair);
      incident.get(pair.b)?.push(pair);
    }
    const pairKey = (pair: { a: string; b: string }) => `${pair.a}|${pair.b}`;
    const slots = new Map<string, { a0: number; a1: number; b0: number; b1: number }>();

    for (const arc of arcs) {
      const list = incident.get(arc.group.code) ?? [];
      if (list.length === 0) continue;
      list.sort((left, right) => {
        const otherLeft = left.a === arc.group.code ? left.b : left.a;
        const otherRight = right.a === arc.group.code ? right.b : right.a;
        return (byCode.get(otherLeft)?.mid ?? 0) - (byCode.get(otherRight)?.mid ?? 0);
      });
      const span = Math.max(0, arc.a1 - arc.a0 - pad * 2);
      const total =
        list.reduce((sum, pair) => sum + (direction === 'small' ? 1 : pair.weight), 0) || 1;
      let cursor = arc.a0 + pad;
      for (const pair of list) {
        const width = (direction === 'small' ? 1 / total : pair.weight / total) * span;
        const slot = slots.get(pairKey(pair)) ?? {
          a0: 0,
          a1: 0,
          b0: 0,
          b1: 0,
        };
        if (pair.a === arc.group.code) {
          slot.a0 = cursor;
          slot.a1 = cursor + width;
        } else {
          slot.b0 = cursor;
          slot.b1 = cursor + width;
        }
        slots.set(pairKey(pair), slot);
        cursor += width;
      }
    }

    const at = (angle: number, radius: number) => ({
      x: cx + Math.cos(angle) * radius,
      y: cy + Math.sin(angle) * radius,
    });

    return activePairs
      .map((pair) => {
        const slot = slots.get(pairKey(pair));
        if (!slot) return null;
        const t = weightT(pair.weight, model.maxWeight);
        const aStart = at(slot.a0, chordR);
        const aEnd = at(slot.a1, chordR);
        const bStart = at(slot.b0, chordR);
        const bEnd = at(slot.b1, chordR);
        const largeA = slot.a1 - slot.a0 > Math.PI ? 1 : 0;
        const largeB = slot.b1 - slot.b0 > Math.PI ? 1 : 0;
        return {
          pair,
          t,
          d: [
            `M ${aStart.x} ${aStart.y}`,
            `A ${chordR} ${chordR} 0 ${largeA} 1 ${aEnd.x} ${aEnd.y}`,
            `L ${bEnd.x} ${bEnd.y}`,
            `A ${chordR} ${chordR} 0 ${largeB} 0 ${bStart.x} ${bStart.y}`,
            'Z',
          ].join(' '),
          opacity:
            direction === 'small' ? (pair.weight === 0 ? 0.55 : 0.3 - t * 0.14) : 0.16 + t * 0.44,
        };
      })
      .filter((link): link is NonNullable<typeof link> => Boolean(link))
      .sort((a, b) => a.pair.weight - b.pair.weight);
  }, [model, byCode, arcs, cx, cy, rInner, direction]);

  const partners = useMemo(() => {
    if (!focus) return [];
    const rows: Array<{ group: OverlapGroup; weight: number }> = [];
    for (const pair of model.pairs) {
      if (pair.a !== focus && pair.b !== focus) continue;
      const other = pair.a === focus ? pair.b : pair.a;
      const group = model.groups.find((item) => item.code === other);
      if (group) rows.push({ group, weight: pair.weight });
    }
    return rows.sort((a, b) => (direction === 'small' ? a.weight - b.weight : b.weight - a.weight));
  }, [focus, model, direction]);

  const focusGroup = focus ? model.groups.find((group) => group.code === focus) : null;

  /** 打开交集成员卡片时先收起右侧列表，两张卡片都贴右上，叠起来会互相挡。 */
  const openPair = (selection: OverlapPairSelection) => {
    setPicked(null);
    setHovered(null);
    setTip(null);
    onOpenPair(selection);
  };

  return (
    <div className="weq-ov-stage" ref={wrapRef}>
      {arcs.length === 0 ? (
        <div className="weq-ov-empty">
          <strong>没有可绘制的群</strong>
          <span>调低重合阈值，或把「参与群数」调大一点。</span>
        </div>
      ) : (
        <svg
          className="weq-ov-chord-svg"
          width={size.w}
          height={size.h}
          viewBox={`0 0 ${size.w} ${size.h}`}
        >
          <defs>
            {arcs.map((arc) => {
              const midR = rOuter - (showAvatars ? 17 : 0);
              const x = cx + Math.cos(arc.mid) * midR;
              const y = cy + Math.sin(arc.mid) * midR;
              return (
                <clipPath key={arc.group.code} id={`${uid}-av-${arc.group.code}`}>
                  <circle cx={x} cy={y} r={showAvatars ? 12 : 0.01} />
                </clipPath>
              );
            })}
          </defs>

          {/* 连线先画，弧段压在上面 */}
          <g className="weq-ov-chord-links">
            {links.map((link) => {
              const active =
                !focus || link.pair.a === focus || link.pair.b === focus ? undefined : 'is-faded';
              return (
                <path
                  key={`${link.pair.a}|${link.pair.b}`}
                  className={`weq-ov-chord-link${active ? ` ${active}` : ''}`}
                  d={link.d}
                  strokeWidth={0.6}
                  fillOpacity={link.opacity}
                  onClick={() =>
                    openPair({
                      a: link.pair.a,
                      b: link.pair.b,
                      weight: link.pair.weight,
                      ratio: link.pair.ratio,
                    })
                  }
                >
                  <title>
                    {`${byCode.get(link.pair.a)?.group.name} ↔ ${byCode.get(link.pair.b)?.group.name}\n共同成员 ${link.pair.weight} 人`}
                  </title>
                </path>
              );
            })}
          </g>

          <g className="weq-ov-chord-arcs">
            {arcs.map((arc) => {
              const dim = focus && focus !== arc.group.code;
              const span = arc.a1 - arc.a0;
              const midR = rOuter - (showAvatars ? 17 : 0);
              const avatarX = cx + Math.cos(arc.mid) * midR;
              const avatarY = cy + Math.sin(arc.mid) * midR;
              const labelR = rOuter + 12;
              const labelX = cx + Math.cos(arc.mid) * labelR;
              const labelY = cy + Math.sin(arc.mid) * labelR;
              const flip = Math.cos(arc.mid) < 0;
              return (
                <g key={arc.group.code} className={dim ? 'is-dim' : undefined}>
                  <path
                    className={`weq-ov-chord-arc${picked === arc.group.code ? ' is-picked' : ''}`}
                    d={arcPath(cx, cy, rOuter, rInner * 0.82, arc.a0, arc.a1)}
                    onMouseEnter={(event) => {
                      setHovered(arc.group.code);
                      const rect = wrapRef.current?.getBoundingClientRect();
                      if (rect) {
                        setTip({
                          x: event.clientX - rect.left + 14,
                          y: event.clientY - rect.top + 14,
                          code: arc.group.code,
                        });
                      }
                    }}
                    onMouseMove={(event) => {
                      const rect = wrapRef.current?.getBoundingClientRect();
                      if (rect) {
                        setTip((current) =>
                          current
                            ? {
                                x: event.clientX - rect.left + 14,
                                y: event.clientY - rect.top + 14,
                                code: current.code,
                              }
                            : current,
                        );
                      }
                    }}
                    onMouseLeave={() => {
                      setHovered(null);
                      setTip(null);
                    }}
                    onClick={() => setPicked(picked === arc.group.code ? null : arc.group.code)}
                    onDoubleClick={() => {
                      // 双击弧段：直接看这个群与其余群的整体重合详情（不跳页面）。
                      const best = model.pairs
                        .filter((pair) => pair.a === arc.group.code || pair.b === arc.group.code)
                        .sort((left, right) =>
                          direction === 'small'
                            ? left.weight - right.weight
                            : right.weight - left.weight,
                        )[0];
                      if (!best) return;
                      openPair({ a: best.a, b: best.b, weight: best.weight, ratio: best.ratio });
                    }}
                  >
                    <title>{`${arc.group.name}\n成员 ${arc.group.memberCount} 人 · 交集总量 ${arc.group.overlapSum}`}</title>
                  </path>
                  {showAvatars && arc.group.avatarUrl && span > 0.03 ? (
                    <image
                      href={arc.group.avatarUrl}
                      x={avatarX - 12}
                      y={avatarY - 12}
                      width={24}
                      height={24}
                      clipPath={`url(#${uid}-av-${arc.group.code})`}
                      preserveAspectRatio="xMidYMid slice"
                      pointerEvents="none"
                      opacity={dim ? 0.35 : 1}
                    />
                  ) : null}
                  {span > MIN_ARC_LABEL && Math.abs(Math.cos(arc.mid)) > 0.5 ? (
                    <text
                      className="weq-ov-chord-label"
                      x={labelX}
                      y={labelY + 4}
                      textAnchor={flip ? 'end' : 'start'}
                      transform={`rotate(${(arc.mid * 180) / Math.PI + (flip ? 180 : 0)} ${labelX} ${labelY + 4})`}
                      opacity={dim ? 0.35 : 1}
                    >
                      {arc.group.name.length > 12
                        ? `${arc.group.name.slice(0, 12)}…`
                        : arc.group.name}
                    </text>
                  ) : null}
                </g>
              );
            })}
          </g>

          {/* 中心：默认总览，选中群后换成该群的交集摘要。底板让数字在密集连线上也读得清。 */}
          <circle
            className="weq-ov-chord-center-plate"
            cx={cx}
            cy={cy}
            r={Math.max(48, rInner * 0.42)}
            pointerEvents="none"
          />
          <g className="weq-ov-chord-center" pointerEvents="none">
            {focusGroup ? (
              <>
                <text className="weq-ov-chord-center-title" x={cx} y={cy - 22} textAnchor="middle">
                  {focusGroup.name.length > 16
                    ? `${focusGroup.name.slice(0, 16)}…`
                    : focusGroup.name}
                </text>
                <text className="weq-ov-chord-center-big" x={cx} y={cy + 10} textAnchor="middle">
                  {focusGroup.poolSize.toLocaleString('zh-CN')}
                </text>
                <text className="weq-ov-chord-center-sub" x={cx} y={cy + 32} textAnchor="middle">
                  位群友在此群
                </text>
                <text className="weq-ov-chord-center-tip" x={cx} y={cy + 54} textAnchor="middle">
                  {direction === 'small'
                    ? `${partners.length} 个群可比较 · 双击看最不重合的`
                    : `${partners.length} 个群有交集 · 双击看最重合的`}
                </text>
              </>
            ) : (
              <>
                <text className="weq-ov-chord-center-big" x={cx} y={cy - 2} textAnchor="middle">
                  {model.groups.length}
                </text>
                <text className="weq-ov-chord-center-sub" x={cx} y={cy + 20} textAnchor="middle">
                  个群 · {model.totalPeople.toLocaleString('zh-CN')} 位群友
                </text>
                <text className="weq-ov-chord-center-tip" x={cx} y={cy + 42} textAnchor="middle">
                  悬停弧段看交集，点击固定
                </text>
              </>
            )}
          </g>
        </svg>
      )}

      {/* 选中群后的交集列表：点击一行查看共同成员，不跳转页面 */}
      {focusGroup ? (
        <aside className="weq-ov-chord-panel">
          <header>
            <strong title={focusGroup.name}>{focusGroup.name}</strong>
            <span>
              {focusGroup.memberCount.toLocaleString('zh-CN')} 人 ·{' '}
              {direction === 'small'
                ? `${partners.length} 个群可比较`
                : `${partners.filter((row) => row.weight > 0).length} 个群有交集`}
            </span>
          </header>
          <div className="weq-ov-chord-panel-list">
            {partners.slice(0, 40).map(({ group, weight }) => (
              <button
                key={group.code}
                type="button"
                className="weq-ov-chord-pair"
                onClick={() =>
                  openPair({
                    a: focusGroup.code,
                    b: group.code,
                    weight,
                    ratio: weight > 0 ? weight / Math.max(1, focusGroup.poolSize) : 0,
                  })
                }
              >
                <span className="weq-ov-chord-pair-avatar">
                  {group.avatarUrl ? (
                    <img src={group.avatarUrl} alt="" referrerPolicy="no-referrer" loading="lazy" />
                  ) : (
                    <span>{(group.name || '?').slice(0, 1)}</span>
                  )}
                </span>
                <span className="weq-ov-chord-pair-name" title={group.name}>
                  {group.name}
                </span>
                <span className={`weq-ov-chord-pair-weight${weight === 0 ? ' is-zero' : ''}`}>
                  {weight === 0 ? '无' : `${weight}`}
                </span>
              </button>
            ))}
          </div>
          <p className="weq-ov-chord-panel-foot">数字 = 两个群的共同成员数 · 点一行看成员</p>
        </aside>
      ) : null}

      {tip ? (
        <div className="weq-ov-chord-tip" style={{ left: tip.x, top: tip.y }}>
          <strong>{model.groups.find((group) => group.code === tip.code)?.name}</strong>
          <span>
            {model.groups.find((group) => group.code === tip.code)?.poolSize ?? 0} 位群友 ·{' '}
            {model.groups.find((group) => group.code === tip.code)?.overlapSum ?? 0} 次交集
          </span>
        </div>
      ) : null}
    </div>
  );
}
