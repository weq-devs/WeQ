import { useEffect, useState, type CSSProperties, type ReactElement } from 'react';
import type { FriendRankEntry, FriendsPageData } from '@weq/service';
import { isAllTimeYear } from '@weq/service/report-time';
import { PageFrame, type ReportPageProps } from '../pageFrame';
import { Odometer } from '../Odometer';
import { avatarFromUin } from '../../../lib/avatarResolver';
import { cachedAvatarUrl } from '../../../lib/avatarCache';

function fmt(n: number): string {
  return new Intl.NumberFormat('zh-CN').format(n);
}

/** 以冠军为满格的百分比。最低给 4%，免得差距悬殊时第三名彻底消失。 */
function ratio(value: number, top: number): number {
  return Math.max(4, Math.round((value / Math.max(1, top)) * 100));
}

/**
 * 好友榜 —— 一页两幕，两张前三榜，**刻意用两种不同的形状**。
 *
 * 两种「第一名」的性质根本不同，用同一个排行榜组件说，这一页就成了同一件事
 * 讲两遍：
 *
 *   - 火花是**时间的延展** → 横向燃烧的引线（{@link FuseBoard}）。三条共起点
 *     左对齐，长度即天数，冠军那条最粗最亮、末端一枚一直在跳的火种。
 *   - 消息量是**体量的堆叠** → 纵向的柱阵（{@link StackBoard}）。三根柱共基线，
 *     高度即条数，柱身是一层层横纹；冠军那根最宽、实色、带辉光，巨数单独摆
 *     在柱阵左侧。
 *
 * 一横一纵、一线一块、一暖橙一靛蓝。共用的只有巨数排印、光环头像和分幕的
 * 发丝线 —— 那是同一份报告的口音，不是同一个组件。
 */
export function FriendsPage({
  page,
  data,
  active,
}: ReportPageProps<FriendsPageData>): ReactElement {
  const allTime = isAllTimeYear(data.year);
  /**
   * 引线的燃烧与柱子的生长都从 0 起步。与总览页的分割轨同一手法：巨数先落定，
   * 形状后铺开 —— 两件事同时动会互相抢视线。
   */
  const [grown, setGrown] = useState(false);

  useEffect(() => {
    if (!active) {
      setGrown(false);
      return undefined;
    }
    const timer = window.setTimeout(() => setGrown(true), 620);
    return () => window.clearTimeout(timer);
  }, [active]);

  return (
    <PageFrame page={page} active={active} ghost={allTime ? 'ALL' : data.year} tone="#c2703d">
      <div className="weq-fr">
        <header className="weq-fr-kicker weq-report-line" style={{ '--i': 1 } as CSSProperties}>
          <span>{allTime ? '历史以来' : `${data.year} 年`} · 和你来往最深的人</span>
          <span className="weq-fr-kicker-meta">
            <b className="weq-number">{fmt(data.friendCount)}</b> 位好友
            <i aria-hidden>/</i>
            <b className="weq-number">{fmt(data.totalMessages)}</b> 条私聊
          </span>
        </header>

        <FuseBoard entries={data.sparkTop} active={active} grown={grown} />
        <StackBoard entries={data.messageTop} active={active} grown={grown} />
      </div>
    </PageFrame>
  );
}

/** 分幕外壳 —— 两幕唯一共用的东西：一条发丝线 + 幕名 + 一句副题。 */
function Board({
  variant,
  eyebrow,
  sub,
  step,
  children,
}: {
  variant: 'spark' | 'msg';
  eyebrow: string;
  sub: string;
  step: number;
  children: ReactElement;
}): ReactElement {
  return (
    <section
      className={`weq-fr-board is-${variant} weq-report-line`}
      style={{ '--i': step } as CSSProperties}
    >
      <div className="weq-fr-board-head">
        <h2 className="weq-fr-board-eyebrow">{eyebrow}</h2>
        <p className="weq-fr-board-sub">{sub}</p>
      </div>
      {children}
    </section>
  );
}

/**
 * 第一幕：最长火花 —— 横向引线。
 *
 * 「连续多少天没断」的自然编码是**长度**，所以三条引线共起点左对齐、按天数
 * 归一化：不看数字也知道第二名差多远。冠军那条 4px 粗、满格、末端着火。
 */
function FuseBoard({
  entries,
  active,
  grown,
}: {
  entries: FriendRankEntry[];
  active: boolean;
  grown: boolean;
}): ReactElement {
  const champion = entries[0];
  const runners = entries.slice(1);

  return (
    <Board variant="spark" eyebrow="最长火花" sub="连着多少天，你们谁都没有断" step={2}>
      {champion ? (
        <div className="weq-fr-fuse">
          <div className="weq-fr-fuse-head">
            <Face name={champion.peerName} uin={champion.peerUin} champion />
            <div className="weq-fr-fuse-who">
              <span className="weq-fr-fuse-name">{champion.peerName}</span>
              <span className="weq-fr-fuse-msgs">{fmt(champion.messages)} 条私聊</span>
            </div>
            <div className="weq-fr-fuse-val">
              <Odometer
                value={champion.value}
                active={active}
                className="weq-fr-fuse-num"
                durationMs={1700}
              />
              <span className="weq-fr-fuse-unit">天</span>
            </div>
          </div>

          {/* 冠军的引线永远满格 —— 它就是这一幕的标尺。 */}
          <div className="weq-fr-fuse-track">
            <span className="weq-fr-fuse-burn" style={{ width: grown ? '100%' : '0%' }}>
              {grown ? <i className="weq-fr-fuse-ember" aria-hidden /> : null}
            </span>
          </div>

          {runners.length > 0 ? (
            <ol className="weq-fr-fuse-runners">
              {runners.map((entry, index) => (
                <li
                  className="weq-fr-fuse-runner"
                  key={entry.peerUid}
                  style={{ '--j': index } as CSSProperties}
                >
                  <span className="weq-fr-fuse-rank" aria-hidden>
                    0{index + 2}
                  </span>
                  <Face name={entry.peerName} uin={entry.peerUin} />
                  <span className="weq-fr-fuse-rname">{entry.peerName}</span>
                  <span className="weq-fr-fuse-rtrack" aria-hidden>
                    <i style={{ width: grown ? `${ratio(entry.value, champion.value)}%` : '0%' }} />
                  </span>
                  <span className="weq-fr-fuse-rval">
                    <b className="weq-number">{fmt(entry.value)}</b>
                    <i>天</i>
                  </span>
                </li>
              ))}
            </ol>
          ) : null}
        </div>
      ) : (
        <p className="weq-fr-empty">还没有连续两天都互相说话的人</p>
      )}
    </Board>
  );
}

/** 柱阵的最高柱像素高。冠军永远这么高，其余按条数等比缩。 */
const STACK_MAX_H = 132;
/** 最矮的柱子也要看得见 —— 长尾末端不能塌成一条线。 */
const STACK_MIN_H = 12;

/**
 * 第二幕：聊得最多 —— 纵向柱阵。
 *
 * 「一共说了多少条」的自然编码是**体积**。八根柱共基线、按条数定高，柱身用
 * 横向重复纹路（一层就是一叠消息）。冠军那根最宽、实色、带辉光，它的巨数
 * 单独摆在柱阵左侧，不跟柱子挤在一起。
 *
 * 取八名而不是三名：柱阵横向铺开，三根撑不满一行；八根才有「一片」的密度，
 * 长尾的坡度也才看得出来。列宽由 grid 等分，名字超出即截断。
 */
function StackBoard({
  entries,
  active,
  grown,
}: {
  entries: FriendRankEntry[];
  active: boolean;
  grown: boolean;
}): ReactElement {
  const champion = entries[0];

  return (
    <Board variant="msg" eyebrow="聊得最多" sub="这段时间里，你们一共说了这么多" step={3}>
      {champion ? (
        <div className="weq-fr-vol">
          <div className="weq-fr-vol-champ">
            <div className="weq-fr-vol-row">
              <Odometer
                value={champion.value}
                active={active}
                className="weq-fr-vol-num"
                durationMs={1700}
              />
              <span className="weq-fr-vol-unit">条</span>
            </div>
            <div className="weq-fr-vol-who">
              <Face name={champion.peerName} uin={champion.peerUin} champion />
              <span className="weq-fr-vol-name">{champion.peerName}</span>
            </div>
          </div>

          <ol className="weq-fr-stacks">
            {entries.map((entry, index) => (
              <li
                className={`weq-fr-stack${index === 0 ? ' is-champion' : ''}`}
                key={entry.peerUid}
                style={{ '--j': index } as CSSProperties}
              >
                <span className="weq-fr-stack-val">
                  <b className="weq-number">{fmt(entry.value)}</b>
                  <i>条</i>
                </span>
                <span
                  className="weq-fr-stack-bar"
                  aria-hidden
                  style={{
                    height: grown
                      ? `${Math.max(
                          STACK_MIN_H,
                          Math.round((entry.value / Math.max(1, champion.value)) * STACK_MAX_H),
                        )}px`
                      : '0px',
                  }}
                />
                <span className="weq-fr-stack-foot">
                  <Face name={entry.peerName} uin={entry.peerUin} />
                  <span className="weq-fr-stack-name">{entry.peerName}</span>
                </span>
              </li>
            ))}
          </ol>
        </div>
      ) : (
        <p className="weq-fr-empty">还没有双向来往的私聊</p>
      )}
    </Board>
  );
}

/**
 * 榜上一张脸。头像走 `weq-media://avatar`（本机 QQ 缓存优先、CDN 兜底），
 * 拿不到就用名字首字顶上 —— 报告不为一张头像缺失留空洞，也不弹任何提示。
 */
function Face({
  name,
  uin,
  champion = false,
}: {
  name: string;
  uin: string;
  champion?: boolean;
}): ReactElement {
  const url = cachedAvatarUrl(avatarFromUin(uin));
  const cls = `weq-fr-face${champion ? ' is-champion' : ''}`;
  if (!url) {
    return (
      <span className={`${cls} is-initial`} aria-hidden>
        {name.slice(0, 1)}
      </span>
    );
  }
  return <img className={cls} src={url} alt="" aria-hidden />;
}
