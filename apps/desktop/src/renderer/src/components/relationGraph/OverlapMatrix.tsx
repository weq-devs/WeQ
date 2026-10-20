/**
 * 群成员重合 · 矩形重叠（热力矩阵）。
 *
 * 行列都是群，格子 = 两个群的共同成员数。色阶按当前「看大重叠 / 看小重叠」切换：
 *  - 大重叠：对数压缩后越深 = 重合越多，一眼找出「同一批人」的群；
 *  - 小重叠：反过来，只有「几乎不重合」的群对才上色，最深的是最该互相认识的。
 *
 * 交互：悬停高亮整行整列并在左上角显示这一对的摘要；点击格子打开共同成员卡片。
 * 行列标签是群头像 + 群名，行首标签固定（滚动时列头跟着滚，行头不跟）。
 */

import { type CSSProperties, useMemo, useState } from 'react';
import type { OverlapModel } from './graphModel';
import type { OverlapPairSelection } from './OverlapPairCard';

interface CellGeom {
  cell: number;
  labelW: number;
  headH: number;
  width: number;
  height: number;
}

/** 群多的时候格子缩小、标签只留头像，保证整张矩阵能塞进可视区。 */
function geometry(count: number, showAvatars: boolean): CellGeom {
  const cell = count <= 24 ? 26 : count <= 40 ? 20 : count <= 60 ? 16 : count <= 90 ? 13 : 10;
  const labelW = showAvatars ? 172 : 132;
  const headH = showAvatars ? 44 : 26;
  return { cell, labelW, headH, width: labelW + count * cell, height: headH + count * cell };
}

function tOf(weight: number, max: number, direction: 'large' | 'small'): number {
  if (direction === 'small') {
    // 0 人的群对最该被看见；权重越大越淡。
    return max <= 0 ? 0 : 1 - Math.min(1, weight / Math.max(1, max));
  }
  return weight <= 0 ? 0 : Math.min(1, Math.log1p(weight) / Math.log1p(Math.max(1, max))) ** 0.72;
}

export function OverlapMatrix({
  model,
  showAvatars,
  showValues,
  direction,
  threshold,
  onOpenPair,
}: {
  model: OverlapModel;
  showAvatars: boolean;
  showValues: boolean;
  direction: 'large' | 'small';
  threshold: number;
  onOpenPair: (selection: OverlapPairSelection) => void;
}) {
  const [hover, setHover] = useState<{ a: string; b: string } | null>(null);
  const groups = model.groups;
  const geom = useMemo(() => geometry(groups.length, showAvatars), [groups.length, showAvatars]);

  const pairMap = useMemo(() => {
    const map = new Map<string, { weight: number; ratio: number }>();
    for (const pair of model.pairs) {
      map.set(`${pair.a}|${pair.b}`, { weight: pair.weight, ratio: pair.ratio });
      map.set(`${pair.b}|${pair.a}`, { weight: pair.weight, ratio: pair.ratio });
    }
    return map;
  }, [model]);

  const byCode = useMemo(() => new Map(groups.map((group) => [group.code, group])), [groups]);

  const hoverSummary = useMemo(() => {
    if (!hover) return null;
    const pair = pairMap.get(`${hover.a}|${hover.b}`);
    const nameA = byCode.get(hover.a)?.name ?? hover.a;
    const nameB = byCode.get(hover.b)?.name ?? hover.b;
    const weight = pair?.weight ?? 0;
    const small = Math.min(byCode.get(hover.a)?.poolSize ?? 0, byCode.get(hover.b)?.poolSize ?? 0);
    return {
      nameA,
      nameB,
      weight,
      percent: small > 0 ? Math.round((weight / small) * 100) : 0,
    };
  }, [hover, pairMap, byCode]);

  if (groups.length === 0) {
    return (
      <div className="weq-ov-stage">
        <div className="weq-ov-empty">
          <strong>没有可比较的群</strong>
          <span>调低重合阈值，或把「参与群数」调大一点。</span>
        </div>
      </div>
    );
  }

  const hint = hoverSummary
    ? `${hoverSummary.nameA} ↔ ${hoverSummary.nameB} · ${hoverSummary.weight} 人${
        hoverSummary.percent > 0 ? `（覆盖较小群的 ${hoverSummary.percent}%）` : ''
      }`
    : direction === 'small'
      ? `只看重合 ≤ ${threshold} 人的群对 · 越深越「几乎不重合」`
      : '颜色越深 = 共同群友越多 · 点格子看成员';

  return (
    <div className="weq-ov-matrix">
      <div className="weq-ov-matrix-bar">
        <span className="weq-ov-matrix-hint" title={hint}>
          {hint}
        </span>
        <span className="weq-ov-matrix-scale">
          <span>{direction === 'small' ? '重合多' : '重合少'}</span>
          <i className="is-low" />
          <i className="is-mid" />
          <i className="is-high" />
          <span>{direction === 'small' ? '几乎不重合' : '重合多'}</span>
        </span>
      </div>

      <div className="weq-ov-matrix-scroll">
        <div
          className={`weq-ov-matrix-grid${geom.cell < 14 ? ' is-tight' : ''}`}
          style={{ width: geom.width, height: geom.height }}
        >
          {/* 左上角留白 */}
          <div className="weq-ov-matrix-corner" style={{ width: geom.labelW, height: geom.headH }}>
            {direction === 'small' ? `≤ ${threshold} 人` : '共同成员'}
          </div>

          {/* 列头 */}
          {groups.map((group, col) => (
            <button
              key={`c-${group.code}`}
              type="button"
              className={`weq-ov-matrix-head${hover?.b === group.code ? ' is-hot' : ''}${
                showAvatars ? ' has-avatar' : ''
              }`}
              style={{ left: geom.labelW + col * geom.cell, width: geom.cell }}
              title={group.name}
              onClick={() => setHover(null)}
            >
              {showAvatars ? (
                group.avatarUrl ? (
                  <img src={group.avatarUrl} alt="" referrerPolicy="no-referrer" loading="lazy" />
                ) : (
                  <span>{(group.name || '?').slice(0, 1)}</span>
                )
              ) : (
                <span className="weq-ov-matrix-head-name">{group.name.slice(0, 4)}</span>
              )}
            </button>
          ))}

          {/* 行头：横向滚动时跟着走（不在 sticky 区域里），所以和格子同一层。 */}
          {groups.map((group, row) => (
            <div
              key={`r-${group.code}`}
              className={`weq-ov-matrix-rowhead${hover?.a === group.code ? ' is-hot' : ''}${
                showAvatars ? ' has-avatar' : ''
              }`}
              style={{ top: geom.headH + row * geom.cell, width: geom.labelW, height: geom.cell }}
              title={group.name}
            >
              {showAvatars && group.avatarUrl ? (
                <img src={group.avatarUrl} alt="" referrerPolicy="no-referrer" loading="lazy" />
              ) : null}
              <span className="weq-ov-matrix-rowname">{group.name}</span>
            </div>
          ))}

          {/* 格子 */}
          {groups.map((rowGroup, row) =>
            groups.map((colGroup, col) => {
              if (row === col) {
                return (
                  <div
                    key={`cell-${rowGroup.code}-${colGroup.code}`}
                    className="weq-ov-matrix-diag"
                    style={{
                      left: geom.labelW + col * geom.cell,
                      top: geom.headH + row * geom.cell,
                      width: geom.cell,
                      height: geom.cell,
                    }}
                  />
                );
              }
              const pair = pairMap.get(`${rowGroup.code}|${colGroup.code}`);
              const weight = pair?.weight ?? 0;
              const t = tOf(weight, model.maxWeight, direction);
              const visible = weight > 0 || direction === 'small';
              const hot =
                hover && (hover.a === rowGroup.code || hover.b === colGroup.code) ? ' is-hot' : '';
              const sel =
                hover && hover.a === rowGroup.code && hover.b === colGroup.code ? ' is-sel' : '';
              return (
                <button
                  key={`cell-${rowGroup.code}-${colGroup.code}`}
                  type="button"
                  tabIndex={-1}
                  className={`weq-ov-matrix-cell${hot}${sel}${visible ? '' : ' is-empty'}`}
                  style={
                    {
                      left: geom.labelW + col * geom.cell,
                      top: geom.headH + row * geom.cell,
                      width: Math.max(1, geom.cell - 1),
                      height: Math.max(1, geom.cell - 1),
                      '--t': String(t),
                    } as CSSProperties
                  }
                  onMouseEnter={() => setHover({ a: rowGroup.code, b: colGroup.code })}
                  onMouseLeave={() => setHover(null)}
                  onClick={() =>
                    onOpenPair({
                      a: rowGroup.code,
                      b: colGroup.code,
                      weight,
                      ratio: pair?.ratio ?? 0,
                    })
                  }
                  title={`${rowGroup.name} ↔ ${colGroup.name}\n共同成员 ${weight} 人`}
                >
                  {showValues && geom.cell >= 22 && weight > 0 ? <span>{weight}</span> : null}
                </button>
              );
            }),
          )}
        </div>
      </div>

      <p className="weq-ov-matrix-foot">
        {groups.length} 个群 · {model.pairs.filter((pair) => pair.weight > 0).length} 对群有交集
        {hoverSummary ? ` · 当前这对覆盖 ${hoverSummary.percent}%` : ''}
      </p>
    </div>
  );
}
