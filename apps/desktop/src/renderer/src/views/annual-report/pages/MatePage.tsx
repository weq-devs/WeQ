import {
  Fragment,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from 'react';
import type { MateCandidate, MatePageData, MateSharedGroup } from '@weq/service';
import { MATE_MOOD, mateAnalysisText, mateHeadline, mateRankLabel } from '@weq/service/report-mate';
import { reportEraLabel } from '@weq/service/report-time';
import { PageFrame, type ReportPageProps } from '../pageFrame';
import { Odometer } from '../Odometer';
import { avatarFromGroupCode, avatarFromUin } from '../../../lib/avatarResolver';
import { cachedAvatarUrl } from '../../../lib/avatarCache';

function fmt(n: number): string {
  return new Intl.NumberFormat('zh-CN').format(n);
}

/** 冠军展示的群数上限 —— 五枚徽记已经够读出 TA 的圈子，剩下的收进 +N。 */
const HERO_GROUPS_SHOW = 5;
/** 光环里游走的“重逢粒子”数量 —— 只负责氛围，不是数据节点。 */
const ORBIT_NODES = 10;
/** 主位之外固定再排四位 —— 连着主位正好「前五个人」，换谁都不会空位。 */
const SWITCH_SHOW = 4;
/** 换人时「头像 / 昵称」对飞的时长，与 `.weq-mt-anim` 的逐层浮现（760ms）同一档。 */
const SWAP_FLIGHT_MS = 760;
/** 一次飞行的最短间隔：飞行途中量到的位置是动画中的位置，落点会发漂，所以不接。 */
const SWAP_LOCK_MS = SWAP_FLIGHT_MS - 120;

/**
 * 还没加好友的同路人 —— 一页关于「圈子里的重逢」。
 *
 * 主体只有一个人：加权重合最高的非好友。TA 的头像顶到版心，光环由一圈慢慢
 * 游走的粒子围成 —— 每个粒子都是一次「在某个群里遇见」。这一页的说服力来自
 * 名字和「N 个群」这两个数字，而不来自解释，所以文案收成一句话，把版面让给
 * 名字、数字和共同群的徽记排。
 *
 * 「共同出没的地方」**不出群名**，只出一排群头像徽记（名次越靠前越大）：群名
 * 动辄十几个字，五段并排立刻把版面填成一堵字墙，还抢掉名字与巨数这两个主角。
 * 群名与人数仍然在（`title` / `aria-label`），只是不在画面上占地方。
 *
 * 主位之外固定排出四位（连着主位就是「前五个人」），点谁就把谁换到主位 ——
 * 名单里**不重复**出现当前主位那位，四枚小卡始终在答「换谁」。
 *
 * 「换谁」这个动作本身被画了出来：点下去之后，被点那位的**头像与昵称**从下面
 * 那格起飞、落到主位；同时让出主位的那位的头像与昵称往下飞、落进名册里空出的
 * 那格 —— 一次真正的**位置交换**，而不是整组重播一次浮现。
 *
 * 实现是 FLIP：换人之前先量下四个元素的旧位置，换完（`useLayoutEffect` 里，
 * 浏览器还没画）再量一次新位置，两边一对就是位移与缩放，交给 Web Animations
 * `element.animate` 去跑 —— 元素从头到尾只有一份，不靠复制一份幽灵。参与飞行的
 * 那两组（`.weq-mt-face-wrap` / 昵称 / 名册小卡）会带上 `data-flying` 停掉
 * `weq-mt-anim` 的逐层浮现：否则 CSS 动画自己的位移与透明度会和 FLIP 叠加，
 * 落点会漂。光环上那圈波纹照旧荡开，其余部分照旧逐层浮现。
 */

/** 换人飞行要用的四个盒子（视觉坐标，含舞台缩放）。 */
type SwapBoxes = {
  face: DOMRect;
  name: DOMRect;
};

/** 一次位置交换的完整计划：旧位置在点击时量，新位置在换完之后量。 */
type SwapFlight = {
  /** 往上飞的那位（被点到的）在 `candidates` 里的名次。 */
  upRank: number;
  /** 往下飞的那位（让出主位的）在 `candidates` 里的名次。 */
  downRank: number;
  up: SwapBoxes;
  down: SwapBoxes;
};
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

  /** 舞台宿主 —— 量飞行盒子与反算舞台缩放都靠它。 */
  const rootRef = useRef<HTMLDivElement>(null);
  /**
   * 这一次换人的飞行计划。放在 state 而不是 ref：渲染时就要知道「谁在飞」，
   * 才能给那两组元素加上 `data-flying`（换人后由 `swapTick` 重新挂载的那一批）。
   */
  const [flight, setFlight] = useState<SwapFlight | null>(null);
  /**
   * 这一次换人里，主位那组（头像 + 昵称）是不是正从下面飞上来 —— 决定要不要
   * 给它们挂 `data-flying` 停掉逐层浮现。
   */
  const heroFlying = flight != null && flight.upRank === focusedRank;
  /** 上一次起飞时刻 —— 飞行途中不接第二次点击（量到的是动画中的位置）。 */
  const flightAtRef = useRef(0);

  const boxOf = (part: 'face' | 'name', rank: number): DOMRect | null => {
    const rect = flyElement(rootRef.current, part, rank)?.getBoundingClientRect();
    return rect && rect.width > 0 && rect.height > 0 ? rect : null;
  };

  /**
   * 换人：先把旧位置量下来（`candidates` 里的名次是稳定的，换前换后同一套下标），
   * 再改状态。落点由 {@link useLayoutEffect} 在换完之后量。
   */
  function focusOn(key: string, rank: number): void {
    if (key === focusKey) return;
    if (performance.now() - flightAtRef.current < SWAP_LOCK_MS) return;
    const upFace = boxOf('face', rank);
    const upName = boxOf('name', rank);
    const downFace = focusedRank >= 0 ? boxOf('face', focusedRank) : null;
    const downName = focusedRank >= 0 ? boxOf('name', focusedRank) : null;
    if (upFace && upName && downFace && downName) {
      flightAtRef.current = performance.now();
      setFlight({
        upRank: rank,
        downRank: focusedRank,
        up: { face: upFace, name: upName },
        down: { face: downFace, name: downName },
      });
    } else {
      // 量不到就退回旧的「整组重播」，不飞也不会错位。
      setFlight(null);
    }
    setFocusKey(key);
    setSwapTick((tick) => tick + 1);
  }

  /**
   * 起飞：此刻 DOM 已是换完之后的布局，量到的就是落点。
   *
   * 舞台是等比缩放的（`transform: scale`），而 `getBoundingClientRect` 给的是缩放后
   * 的视觉坐标、WAAPI 的 `translate` 走的是元素自己的局部坐标 —— 所以位移要除以
   * 舞台缩放，缩放比则是比值、不用管缩放。用 `offsetWidth`（布局宽）反算舞台缩放，
   * 比去猜 960 的设计宽可靠。
   */
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!flight || !root) return;
    const layoutWidth = root.offsetWidth;
    const scale = layoutWidth > 0 ? root.getBoundingClientRect().width / layoutWidth || 1 : 1;
    const fly = (part: 'face' | 'name', rank: number, from: DOMRect): void => {
      const target = flyElement(root, part, rank);
      if (!target) return;
      const to = target.getBoundingClientRect();
      if (to.width <= 0 || to.height <= 0) return;
      target.animate(
        [
          {
            transformOrigin: 'top left',
            transform: `translate(${(from.left - to.left) / scale}px, ${
              (from.top - to.top) / scale
            }px) scale(${from.width / to.width}, ${from.height / to.height})`,
          },
          { transformOrigin: 'top left', transform: 'none' },
        ],
        { duration: SWAP_FLIGHT_MS, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
      );
    };
    fly('face', flight.upRank, flight.up.face);
    fly('name', flight.upRank, flight.up.name);
    fly('face', flight.downRank, flight.down.face);
    fly('name', flight.downRank, flight.down.name);
  }, [flight]);

  return (
    <PageFrame page={page} active={active} ghost="缘" tone="#3e7f77">
      <div className="weq-mt" data-has-top={top ? 'yes' : 'no'} ref={rootRef}>
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

            {/*
              换人时整组重新挂载：下面每个 `--i` 都在这组里按序重播一次浮现。
              参与上下对飞的那两组停掉浮现（`data-flying`）—— 它们的动由 FLIP 负责，
              见 useLayoutEffect。
            */}
            <Fragment key={swapTick}>
              <section className="weq-mt-hero">
                <p className="weq-mt-lede weq-mt-anim" style={{ '--i': 1 } as CSSProperties}>
                  你们还不是好友，却总在同一个圈子里碰面。
                </p>
                <div
                  className="weq-mt-face-wrap weq-mt-anim"
                  data-flying={heroFlying ? 'yes' : undefined}
                  style={{ '--i': 2 } as CSSProperties}
                >
                  <Face name={focused.name} uin={focused.uin} fly={`face:${focusedRank}`} />
                </div>
                <h2
                  className={`weq-mt-name weq-mt-anim ${nameSize(focused.name)}`}
                  data-flying={heroFlying ? 'yes' : undefined}
                  data-mate-fly={`name:${focusedRank}`}
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
                <div className="weq-mt-crest">
                  {focused.groups.slice(0, HERO_GROUPS_SHOW).map((group, index) => (
                    <GroupCrest group={group} rank={index} key={group.groupCode} />
                  ))}
                  {focused.sharedCount > focused.groups.length ? (
                    <span className="weq-mt-crest-plus">
                      +{fmt(focused.sharedCount - focused.groups.length)}
                    </span>
                  ) : null}
                </div>
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
                        data-flying={flight?.downRank === rank ? 'yes' : undefined}
                        style={{ '--i': 9 + index } as CSSProperties}
                      >
                        <button
                          type="button"
                          className="weq-mt-switch"
                          onClick={() => focusOn(mateKey(candidate), rank)}
                        >
                          <span className="weq-mt-switch-top">
                            <span className="weq-mt-more-rank" aria-hidden>
                              {String(rank + 1).padStart(2, '0')}
                            </span>
                            <Face name={candidate.name} uin={candidate.uin} fly={`face:${rank}`} />
                            <span className="weq-mt-more-name" data-mate-fly={`name:${rank}`}>
                              {candidate.name}
                            </span>
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

/**
 * 按 `data-mate-fly` 在报告页里找「正在飞」的那个元素。记号是 `part:名次`
 * （`face:0` / `name:0`），同一个人在名册里与主位上共用同一个记号 —— 换人前后
 * 用同一个选择器就能量到它的旧位置与新位置。名次在 `candidates` 里是稳定的，
 * 不会因为换人而改号，所以两边的记号一定对得上。
 */
function flyElement(
  root: HTMLElement | null,
  part: 'face' | 'name',
  rank: number,
): HTMLElement | null {
  return root?.querySelector<HTMLElement>(`[data-mate-fly="${part}:${rank}"]`) ?? null;
}

/**
 * 一枚共同群徽记：只有群头像，没有群名。
 *
 * `rank` 同时是名次与大小 —— 0 最大，往后依次收敛，一排看过去像一组由重到轻
 * 的音阶，比五段等宽文字更安静，也更像一份刊物里的徽记。群名与人数收进
 * `title`（悬停可看）与 `aria-label`（读得出），信息没丢，版面不脏。
 */
function GroupCrest({ group, rank }: { group: MateSharedGroup; rank: number }): ReactElement {
  const url = cachedAvatarUrl(avatarFromGroupCode(group.groupCode));
  const label = `${group.groupName} · ${fmt(group.memberCount)} 人`;
  return (
    <span className={`weq-mt-crest-item is-r${rank}`} title={label} role="img" aria-label={label}>
      {url ? (
        <img className="weq-mt-crest-face" src={url} alt="" />
      ) : (
        <span className="weq-mt-crest-face is-initial">{group.groupName.slice(0, 1)}</span>
      )}
    </span>
  );
}

/**
 * 一颗头像：本机缓存 + CDN 兜底，缺失时用首字。
 *
 * `fly` 是这颗头像在「换人飞行」里的记号（`face:<名次>`）—— 同一个人在名册里和
 * 在主位上共用同一个记号，于是换人前后都能用同一个选择器量到它的旧、新位置。
 */
function Face({ name, uin, fly }: { name: string; uin: string; fly?: string }): ReactElement {
  const url = cachedAvatarUrl(avatarFromUin(uin));
  const cls = 'weq-mt-face';
  if (!url) {
    return (
      <span className={`${cls} is-initial`} aria-hidden data-mate-fly={fly}>
        {name.slice(0, 1)}
      </span>
    );
  }
  return <img className={cls} src={url} alt="" aria-hidden data-mate-fly={fly} />;
}
