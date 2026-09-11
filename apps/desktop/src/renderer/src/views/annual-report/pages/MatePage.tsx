import { Fragment, useState, type CSSProperties, type ReactElement } from 'react';
import type { MateCandidate, MatePageData } from '@weq/service';
import { MATE_MOOD, mateAnalysisText, mateHeadline, mateRankLabel } from '@weq/service/report-mate';
import { reportEraLabel } from '@weq/service/report-time';
import { PageFrame, type ReportPageProps } from '../pageFrame';
import { Odometer } from '../Odometer';
import { avatarFromUin } from '../../../lib/avatarResolver';
import { cachedAvatarUrl } from '../../../lib/avatarCache';

function fmt(n: number): string {
  return new Intl.NumberFormat('zh-CN').format(n);
}

/** 冠军展示的群数上限 —— 五六个已经足够读出 TA 的圈子，剩下的收进 +N。 */
const HERO_GROUPS_SHOW = 5;
/** 光环里游走的“重逢粒子”数量 —— 只负责氛围，不是数据节点。 */
const ORBIT_NODES = 10;
/** 主位之外固定再排四位 —— 连着主位正好「前五个人」，换谁都不会空位。 */
const SWITCH_SHOW = 4;

/**
 * 还没加好友的同路人 —— 一页关于「圈子里的重逢」。
 *
 * 主体只有一个人：加权重合最高的非好友。TA 的头像顶到版心，光环由一圈慢慢
 * 游走的粒子围成 —— 每个粒子都是一次「在某个群里遇见」。这一页的说服力来自
 * 名字和「N 个群」这两个数字，而不来自解释，所以文案收成一句话，把版面让给
 * 名字、数字和共同群名单。
 *
 * 主位之外固定排出四位（连着主位就是「前五个人」），点谁就把谁换到主位 ——
 * 名单里**不重复**出现当前主位那位，四枚小卡始终在答「换谁」。换人时主位、
 * 证据、名单整组重新挂载（`swapTick` 换 key），于是 `weq-mt-anim` 的逐层浮现
 * 重播一次，光环上再荡开一圈波纹 —— 「换了一个人」这件事因此被看见。
 */
export function MatePage({ page, data, active }: ReportPageProps<MatePageData>): ReactElement {
  const top = data.top;
  const candidates = top ? [top, ...data.more] : [];
  const [focusKey, setFocusKey] = useState<string | null>(top ? mateKey(top) : null);
  /** 换人次数。0 = 还没换过，进场由 `--i` 逐层浮现；>0 起播换人动画。 */
  const [swapTick, setSwapTick] = useState(0);
  const focused = candidates.find((candidate) => mateKey(candidate) === focusKey) ?? top ?? null;
  const focusedRank = focused
    ? candidates.findIndex((candidate) => mateKey(candidate) === mateKey(focused))
    : -1;
  /** 待在下方等换人的四位 —— 当前主位那位不在这里重复出现。 */
  const others = focused
    ? candidates
        .map((candidate, rank) => ({ candidate, rank }))
        .filter((row) => mateKey(row.candidate) !== mateKey(focused))
        .slice(0, SWITCH_SHOW)
    : [];

  function focusOn(key: string): void {
    if (key === focusKey) return;
    setFocusKey(key);
    setSwapTick((tick) => tick + 1);
  }

  return (
    <PageFrame page={page} active={active} ghost="缘" tone="#3e7f77">
      <div className="weq-mt" data-has-top={top ? 'yes' : 'no'}>
        <header className="weq-mt-kicker weq-mt-anim" style={{ '--i': 0 } as CSSProperties}>
          <span>{reportEraLabel(data.year)} · 还没加好友的同路人</span>
          <span className="weq-mt-kicker-meta">
            <b className="weq-number">{fmt(data.groupCount)}</b> 个群
            <i aria-hidden>/</i>
            <b className="weq-number">{fmt(data.personCount)}</b> 位群友
          </span>
        </header>

        {focused && top ? (
          <>
            <div className="weq-mt-orbit" data-enter={active ? 'in' : 'out'} aria-hidden>
              <i className="weq-mt-ring is-a" />
              <i className="weq-mt-ring is-b" />
              {swapTick > 0 ? <i className="weq-mt-flash" key={swapTick} /> : null}
              {Array.from({ length: ORBIT_NODES }, (_, index) => (
                <i
                  // biome-ignore lint/suspicious/noArrayIndexKey: 粒子是静态装饰，列表永不变。
                  key={index}
                  className="weq-mt-node"
                  style={{ '--n': index, '--k': index % 2 } as CSSProperties}
                />
              ))}
            </div>

            {/* 换人时整组重新挂载：下面每个 `--i` 都在这组里按序重播一次浮现。 */}
            <Fragment key={swapTick}>
              <section className="weq-mt-hero">
                <p className="weq-mt-lede weq-mt-anim" style={{ '--i': 1 } as CSSProperties}>
                  你们还不是好友，却总在同一个圈子里碰面。
                </p>
                <div className="weq-mt-face-wrap weq-mt-anim" style={{ '--i': 2 } as CSSProperties}>
                  <Face name={focused.name} uin={focused.uin} />
                </div>
                <h2
                  className={`weq-mt-name weq-mt-anim ${nameSize(focused.name)}`}
                  style={{ '--i': 3 } as CSSProperties}
                >
                  {focused.name}
                </h2>
                <p className="weq-mt-countline weq-mt-anim" style={{ '--i': 4 } as CSSProperties}>
                  <Odometer
                    value={focused.sharedCount}
                    active={active}
                    className="weq-mt-count"
                    durationMs={1400}
                  />
                  <span className="weq-mt-unit" aria-hidden>
                    <b>个群</b>
                    <i>里有 TA</i>
                  </span>
                </p>
                <p className="weq-mt-rankline weq-mt-anim" style={{ '--i': 5 } as CSSProperties}>
                  <span>{mateRankLabel(focusedRank)}</span>
                  <i aria-hidden>/</i>
                  <span>
                    同频指数 <b className="weq-number">{fmtScore(focused.score)}</b>
                  </span>
                </p>
              </section>

              <section className="weq-mt-why weq-mt-anim" style={{ '--i': 6 } as CSSProperties}>
                <b>{mateHeadline(focused, focusedRank)}</b>
                <p>{mateAnalysisText(focused, focusedRank, candidates)}</p>
              </section>

              <section className="weq-mt-cluster weq-mt-anim" style={{ '--i': 7 } as CSSProperties}>
                <p className="weq-mt-cluster-in">你们这些共同出没的地方</p>
                <p className="weq-mt-chips">
                  {focused.groups.slice(0, HERO_GROUPS_SHOW).map((group, index) => (
                    <span className="weq-mt-chip" key={group.groupCode}>
                      <i aria-hidden>{String(index + 1).padStart(2, '0')}</i>
                      {group.groupName}
                    </span>
                  ))}
                  {focused.sharedCount > focused.groups.length ? (
                    <span className="weq-mt-chip is-more">
                      +{fmt(focused.sharedCount - focused.groups.length)}
                    </span>
                  ) : null}
                </p>
              </section>

              {others.length > 0 ? (
                <div className="weq-mt-switchwrap">
                  <p className="weq-mt-more-in weq-mt-anim" style={{ '--i': 8 } as CSSProperties}>
                    前五里的其他同路人 · 点一下换到主位
                  </p>
                  <ol className="weq-mt-more">
                    {others.map(({ candidate, rank }, index) => (
                      <li
                        className="weq-mt-more-item weq-mt-anim"
                        key={mateKey(candidate)}
                        style={{ '--i': 9 + index } as CSSProperties}
                      >
                        <button
                          type="button"
                          className="weq-mt-switch"
                          onClick={() => focusOn(mateKey(candidate))}
                        >
                          <span className="weq-mt-switch-top">
                            <span className="weq-mt-more-rank" aria-hidden>
                              {String(rank + 1).padStart(2, '0')}
                            </span>
                            <Face name={candidate.name} uin={candidate.uin} />
                            <span className="weq-mt-more-name">{candidate.name}</span>
                          </span>
                          <span className="weq-mt-switch-bottom">
                            <b className="weq-mt-more-val weq-number">
                              {fmt(candidate.sharedCount)}
                            </b>
                            <i className="weq-mt-more-unit">个群</i>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ol>
                </div>
              ) : null}
            </Fragment>

            <p className="weq-mt-mood weq-mt-anim" style={{ '--i': 13 } as CSSProperties}>
              {MATE_MOOD}
            </p>
          </>
        ) : (
          <section className="weq-mt-empty">
            <p>这些圈子里，还没有出现过值得专门打招呼的「重逢」。</p>
            <p className="weq-mt-empty-sub">多待几个喜欢的圈子，同频的人总会再出现。</p>
          </section>
        )}
      </div>
    </PageFrame>
  );
}

/** 稳定的候选 key：uid 优先，老数据退回 QQ 号/名字。 */
function mateKey(candidate: MateCandidate): string {
  return candidate.uid || candidate.uin || candidate.name;
}

/** 指数在屏幕/导出上都只显示两位以内的小数。 */
function fmtScore(score: number): string {
  return score >= 100 ? fmt(Math.round(score)) : score.toFixed(score >= 10 ? 1 : 2);
}

/** 名字越长字号越小，始终只占一行。 */
function nameSize(name: string): string {
  const width = [...name].reduce((sum, char) => sum + (/\p{Script=Han}/u.test(char) ? 1 : 0.6), 0);
  if (width > 9) return 'is-xl';
  if (width > 6) return 'is-long';
  return '';
}

/** 一颗头像：本机缓存 + CDN 兜底，缺失时用首字。 */
function Face({ name, uin }: { name: string; uin: string }): ReactElement {
  const url = cachedAvatarUrl(avatarFromUin(uin));
  const cls = 'weq-mt-face';
  if (!url) {
    return (
      <span className={`${cls} is-initial`} aria-hidden>
        {name.slice(0, 1)}
      </span>
    );
  }
  return <img className={cls} src={url} alt="" aria-hidden />;
}
