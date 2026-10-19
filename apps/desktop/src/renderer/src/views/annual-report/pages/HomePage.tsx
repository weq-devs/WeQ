import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type WheelEvent as ReactWheelEvent,
} from 'react';
import type { HomeGroupCard, HomePageData } from '@weq/service';
import { isAllTimeYear, reportEraLabel } from '@weq/service/report-time';
import { PageFrame, type ReportPageProps } from '../pageFrame';
import { Odometer } from '../Odometer';
import { useReportView } from '../reportContext';

function fmt(n: number): string {
  return new Intl.NumberFormat('zh-CN').format(n);
}

/** 数字越长字号越小：卡宽固定，不能靠换行，也不让数字盖到群名上。 */
function countSizeClass(value: number): string {
  if (value >= 1_000_000) return 'is-xl';
  if (value >= 100_000) return 'is-long';
  return '';
}

/** 卡片宽度 / 间距（设计画幅 960px 内的固定值，舞台整体缩放）。 */
const CARD_WIDTH = 336;
const CARD_GAP = 18;
/** 滚轮累计超过这个值转动一格；同一手势只转一格，停 260ms 后才解锁。 */
const WHEEL_STEP = 56;
const WHEEL_IDLE_MS = 260;
/** 横向拖动超过这个像素才切换卡片。 */
const DRAG_STEP = 36;

/** 群头像走公开 CDN；拿不到时卡片里退回首字。 */
function groupAvatarUrl(code: string): string {
  return `https://p.qlogo.cn/gh/${code}/${code}/0`;
}

/**
 * 我的主场 —— 这一页现在回答的是「你把话留给了哪些群」：前 8 个群做成一条
 * **没有边界的轮盘**，卡片从画面左右边缘进出。向下滚动先转轮盘，转到最后一
 * 张后再滚才翻到下一页（由报告舞台的翻页守卫完成）。
 *
 * 冠军群仍然保留「主场的仪式感」：第一张卡片带群等级 / 头衔这些签名信息，
 * 其余卡片只讲数字与一年内的周曲线。
 */
export function HomePage({ page, data, active }: ReportPageProps<HomePageData>): ReactElement {
  const allTime = isAllTimeYear(data.year);
  const top = data.top;
  const rawCards: Array<Partial<HomeGroupCard>> = data.groups?.length
    ? data.groups
    : top
      ? [
          {
            groupCode: top.groupCode ?? '',
            groupName: top.groupName,
            sentCount: top.sentCount ?? 0,
            totalCount: top.groupTotal ?? 0,
            memberCount: top.memberCount ?? 0,
            weekly: [],
          },
        ]
      : [];
  const cards = rawCards
    .map((card) => ({
      ...card,
      groupCode: String(card.groupCode ?? ''),
      groupName: String(card.groupName || card.groupCode || '未命名群聊'),
      sentCount: Number(card.sentCount) || 0,
      totalCount: Number(card.totalCount) || 0,
      memberCount: Number(card.memberCount) || 0,
      weekly: Array.isArray(card.weekly) ? card.weekly.map((count) => Number(count) || 0) : [],
    }))
    .slice(0, 8);

  const [wheel, setWheel] = useState(0);
  const cardCount = cards.length;
  const activeIndex = Math.min(wheel, Math.max(0, cardCount - 1));
  const indexRef = useRef(activeIndex);
  indexRef.current = activeIndex;
  const wheelGesture = useRef({ acc: 0, lastAt: 0, fired: false });
  const dragRef = useRef<{
    x: number;
    y: number;
    horizontal: boolean;
  } | null>(null);
  const suppressClickRef = useRef(false);
  const { registerPageGuard } = useReportView();

  // 换年份 / 换数据时回到第一张；冠军兜底卡可能导致卡片数变化，也要夹住索引。
  useEffect(() => {
    setWheel(0);
  }, [data.year]);

  useEffect(() => {
    setWheel((current) => Math.min(current, Math.max(0, cardCount - 1)));
  }, [cardCount]);

  // 键盘 / 竖向滑动经过报告舞台的 guard：一次手势转一格，转到边界才放行翻页。
  // 只有当前页能注册 —— 所有页都常驻在 deck 里，非当前页注册会抢走别的页的翻页。
  useEffect(() => {
    if (!active || cardCount <= 1) return undefined;
    return registerPageGuard((direction) => {
      const current = indexRef.current;
      if (direction > 0 && current < cardCount - 1) {
        setWheel(current + 1);
        return true;
      }
      if (direction < 0 && current > 0) {
        setWheel(current - 1);
        return true;
      }
      return false;
    });
  }, [active, registerPageGuard, cardCount]);

  /**
   * 滚轮：在轮盘内部先把这一甩吃掉；转到边界后**不再 stopPropagation**，
   * 让报告舞台拿到后续滚动去翻页。这与舞台自己的「一甩一页」判定互补。
   */
  const onWheel = (event: ReactWheelEvent<HTMLDivElement>): void => {
    if (cardCount <= 1) return;
    const now = performance.now();
    const gesture = wheelGesture.current;
    if (now - gesture.lastAt > WHEEL_IDLE_MS) {
      gesture.acc = 0;
      gesture.fired = false;
    }
    gesture.lastAt = now;

    if (gesture.fired) {
      event.stopPropagation();
      return;
    }
    gesture.acc += event.deltaY;
    if (Math.abs(gesture.acc) < WHEEL_STEP) {
      event.stopPropagation();
      return;
    }

    const direction = gesture.acc > 0 ? 1 : -1;
    gesture.acc = 0;
    const current = indexRef.current;
    const atEdge = direction > 0 ? current >= cardCount - 1 : current <= 0;
    if (atEdge) {
      // 到底了：放给舞台，继续滚就翻页。
      return;
    }
    gesture.fired = true;
    event.stopPropagation();
    setWheel(current + direction);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    dragRef.current = { x: event.clientX, y: event.clientY, horizontal: false };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.horizontal && Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) {
      drag.horizontal = true;
    }
    // 横向手势：拦住报告舞台，别让它把这次拖动当成翻页。
    if (drag.horizontal) event.stopPropagation();
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag?.horizontal) return;
    event.stopPropagation();
    suppressClickRef.current = true;
    // 拖动结束可能不落在卡片上、也就没有 click 来消费这个标记；
    // 下一个任务里清掉，避免把下一次正常点击吞掉。
    window.setTimeout(() => {
      suppressClickRef.current = false;
    }, 0);
    const dx = event.clientX - drag.x;
    if (Math.abs(dx) < DRAG_STEP) return;
    const current = indexRef.current;
    const next = dx < 0 ? current + 1 : current - 1;
    setWheel(Math.max(0, Math.min(cardCount - 1, next)));
  };

  const viewportStyle = {
    '--wheel-card-width': `${CARD_WIDTH}px`,
    '--wheel-step': `${CARD_WIDTH + CARD_GAP}px`,
  } as CSSProperties;
  const trackStyle = {
    '--wheel-index': activeIndex,
  } as CSSProperties;

  return (
    <PageFrame page={page} active={active} ghost="群" tone="#a97b2e">
      <div className="weq-home is-wheel" data-has-top={top ? 'yes' : 'no'} onWheel={onWheel}>
        <header className="weq-home-kicker weq-report-line" style={{ '--i': 1 } as CSSProperties}>
          <span>{reportEraLabel(data.year)} · 我的主场</span>
          <span className="weq-home-kicker-meta">
            <b className="weq-number">{fmt(data.activeGroupCount)}</b> 个群说过话
            <i aria-hidden>/</i>
            <b className="weq-number">{fmt(data.groupSentTotal)}</b> 条群消息
          </span>
        </header>

        {cards.length > 0 ? (
          <>
            <p className="weq-home-lede weq-report-line" style={{ '--i': 2 } as CSSProperties}>
              {allTime ? '有记录以来' : `${data.year} 年`}，你把最多的话，留给了这些地方——
            </p>

            <div
              className="weq-home-wheel-viewport"
              style={viewportStyle}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={() => {
                dragRef.current = null;
              }}
              role="list"
              aria-label="发言最多的群聊轮盘"
            >
              <div className="weq-home-wheel-track" style={trackStyle} data-count={cardCount}>
                {cards.map((card, index) => {
                  const isActive = index === activeIndex;
                  const distance = Math.abs(index - activeIndex);
                  const hidden = distance > 2;
                  const share =
                    data.groupSentTotal > 0
                      ? Math.round((card.sentCount / data.groupSentTotal) * 100)
                      : 0;
                  const isChampion = top?.groupCode === card.groupCode;
                  const sparkMax = Math.max(1, ...card.weekly);
                  return (
                    <article
                      // biome-ignore lint/suspicious/noArrayIndexKey: 轮盘顺序稳定，群号可能因缓存数据缺失而重复
                      key={`${card.groupCode}:${index}`}
                      className="weq-home-wheel-card"
                      data-active={isActive ? 'yes' : 'no'}
                      data-hidden={hidden ? 'yes' : 'no'}
                      data-champion={isChampion ? 'yes' : 'no'}
                      aria-current={isActive}
                      role="listitem"
                      onClick={() => {
                        if (suppressClickRef.current) {
                          suppressClickRef.current = false;
                          return;
                        }
                        setWheel(index);
                      }}
                    >
                      <div className="weq-home-wheel-top">
                        <span className="weq-home-wheel-avatar">
                          <img src={groupAvatarUrl(card.groupCode)} alt="" loading="lazy" />
                          <span aria-hidden>{card.groupName.slice(0, 1)}</span>
                        </span>
                        <span className="weq-home-wheel-rank">
                          {String(index + 1).padStart(2, '0')}
                        </span>
                      </div>

                      <strong className="weq-home-wheel-name" title={card.groupName}>
                        {card.groupName}
                      </strong>

                      <p className={`weq-home-wheel-count ${countSizeClass(card.sentCount)}`}>
                        {isActive ? (
                          <Odometer
                            value={card.sentCount}
                            active={active && isActive}
                            className="weq-home-wheel-number weq-number"
                            durationMs={1300}
                          />
                        ) : (
                          <span className="weq-home-wheel-number weq-number">
                            {fmt(card.sentCount)}
                          </span>
                        )}
                        <span className="weq-home-wheel-unit">
                          <b>条</b>
                          <i>发言</i>
                        </span>
                        <span className="weq-home-wheel-share">{share}% 的群聊</span>
                      </p>

                      <div className="weq-home-wheel-spark" aria-hidden>
                        {card.weekly.length > 0 ? (
                          card.weekly.map((count, weekIndex) => (
                            <span
                              // biome-ignore lint/suspicious/noArrayIndexKey: 周序列按位置对齐
                              key={weekIndex}
                              data-empty={count === 0 ? 'yes' : 'no'}
                              style={{
                                height: count === 0 ? '6%' : `${14 + (count / sparkMax) * 86}%`,
                              }}
                            />
                          ))
                        ) : (
                          <span className="weq-home-wheel-spark-empty">暂无周曲线</span>
                        )}
                      </div>

                      {(card.memberCount > 0 || (isChampion && top)) && (
                        <footer className="weq-home-wheel-foot">
                          {card.memberCount > 0 ? (
                            <span>
                              <b>{fmt(card.memberCount)}</b> 位成员
                            </span>
                          ) : (
                            <span aria-hidden />
                          )}
                          {isChampion && top ? <Signature top={top} /> : null}
                        </footer>
                      )}
                    </article>
                  );
                })}
              </div>
            </div>

            <div
              className="weq-home-wheel-caption weq-report-line"
              style={{ '--i': 3 } as CSSProperties}
            >
              <span className="weq-home-wheel-dots" aria-hidden>
                {cards.map((card, index) => (
                  <i key={card.groupCode} data-on={index === activeIndex ? 'yes' : 'no'} />
                ))}
              </span>
              <span>
                {String(activeIndex + 1).padStart(2, '0')} / {String(cards.length).padStart(2, '0')}
              </span>
              <span className="weq-home-wheel-hint">滚动转动轮盘 · 到底继续向下翻页</span>
            </div>
          </>
        ) : (
          <p className="weq-home-empty">群聊记录还在，但本地资料不够，讲不出这座主场。</p>
        )}
      </div>
    </PageFrame>
  );
}

/** 冠军卡的签名行：群等级 / 头衔 / 群规模里能拿到的部分。 */
function Signature({ top }: { top: NonNullable<HomePageData['top']> }): ReactElement | null {
  const items: string[] = [];
  if (top.memberLevel > 0) items.push(`LV.${top.memberLevel}`);
  if (top.customTitle) items.push(top.customTitle);
  else if (top.role === 'owner') items.push('群主');
  else if (top.role === 'admin') items.push('管理员');
  if (items.length === 0) return null;
  return (
    <span className="weq-home-wheel-sig">
      {items.map((item) => (
        <i key={item}>{item}</i>
      ))}
    </span>
  );
}
