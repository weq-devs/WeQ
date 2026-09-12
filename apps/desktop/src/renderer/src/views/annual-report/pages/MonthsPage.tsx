import type { CSSProperties, ReactElement } from 'react';
import type { MonthsPageData, MonthFriendEntry } from '@weq/service';
import { reportEraLabel } from '@weq/service/report-time';
import { PageFrame, type ReportPageProps } from '../pageFrame';
import { Odometer } from '../Odometer';
import { avatarFromUin } from '../../../lib/avatarResolver';
import { cachedAvatarUrl } from '../../../lib/avatarCache';

function fmt(n: number): string {
  return new Intl.NumberFormat('zh-CN').format(n);
}

const MONTH_LABELS = [
  '一月',
  '二月',
  '三月',
  '四月',
  '五月',
  '六月',
  '七月',
  '八月',
  '九月',
  '十月',
  '十一月',
  '十二月',
];

/**
 * 陪你走过 12 个月 —— 不是又一张好友榜，而是一份「时间怎么筛人」的月历。
 *
 * 好友榜把一整年压成一个总数，这一页把它摊回十二枚格子：每个月谁和你聊得
 * 最多，谁的脸就贴在那一格里。视觉上只有一个主体 —— 霸榜最多的「年度聊伴」：
 * 大头像、大名字、一个巨数（TA 拿过几个月的第一），十二格月历只是它脚下的
 * 证据链。陪 TA 的月份被描亮，其它月份安静地退到纸面之下。
 */
export function MonthsPage({ page, data, active }: ReportPageProps<MonthsPageData>): ReactElement {
  const champion = data.champion;
  /**
   * 日历 = 去年的滚动补足格（升序）+ 今年的格子。补足只含去年尾部月份
   * （例：现在 9 月 → 去年 10-12 月），与今年 1-9 月拼起来恰好 12 格。
   */
  const carryover = data.carryoverMonths ?? [];
  const months = [...carryover.map((cell) => ({ ...cell, carried: true })), ...data.months];
  const championUid = champion?.peerUid;
  /** 服务端已经按「可见的 12 格（含去年补足格）」数过胜场。 */
  const championCells = champion ? data.championMonths : 0;
  const nearTwelve = carryover.length > 0;

  return (
    <PageFrame page={page} active={active} ghost={data.year} tone="#b04864">
      <div className="weq-mo" data-has-champion={champion ? 'yes' : 'no'}>
        <header className="weq-mo-kicker weq-report-line" style={{ '--i': 1 } as CSSProperties}>
          <span>{reportEraLabel(data.year)} · 陪你走过12个月</span>
          <span className="weq-mo-kicker-meta">
            <b className="weq-number">{fmt(data.friendCount)}</b> 位好友
            <i aria-hidden>/</i>
            <b className="weq-number">{fmt(data.totalMessages)}</b> 条私聊
          </span>
        </header>

        {champion ? (
          <>
            <section className="weq-mo-hero weq-report-line" style={{ '--i': 2 } as CSSProperties}>
              <p className="weq-mo-lede">
                {reportEraLabel(data.year)}
                {carryover.length > 0 ? '（近 12 个月）' : ''}
                ，每个月坐上聊天榜首的人一直在换，可回头一看，始终在的是——
              </p>
              <Face person={champion} champion />
              <h2 className={`weq-mo-name ${nameSize(champion.peerName)}`}>{champion.peerName}</h2>
              <p className="weq-mo-countline">
                <Odometer
                  value={championCells}
                  active={active}
                  className="weq-mo-count"
                  durationMs={1700}
                />
                <span className="weq-mo-unit" aria-hidden>
                  <b>个月</b>
                  <i>的聊天第一名</i>
                </span>
              </p>
              <p className="weq-mo-note">
                {championCells >= data.monthCount && !nearTwelve
                  ? '一整年，十二个月，TA 从没把第一让给过任何人。'
                  : `TA 拿下了 ${fmt(championCells)} 个月的榜首，${
                      nearTwelve ? '近 12 个月' : data.monthCount < 12 ? '今年' : '全年'
                    }和你聊了 ${fmt(champion.messages)} 句。`}
              </p>
            </section>

            <section
              className="weq-mo-calendar weq-report-line"
              style={{ '--i': 3 } as CSSProperties}
            >
              <p className="weq-mo-calendar-head">十二个月里的榜首</p>
              <ol className="weq-mo-months">
                {months.map((cell, index) => (
                  <li
                    className={`weq-mo-month${cell.top?.peerUid === championUid ? ' is-ours' : ''}${
                      cell.top ? '' : ' is-quiet'
                    }${'carried' in cell && cell.carried ? ' is-carried' : ''}`}
                    key={`${cell.carried ? 'ly' : 'ty'}-${cell.month}`}
                    style={{ '--j': index } as CSSProperties}
                  >
                    <span className="weq-mo-month-label">{MONTH_LABELS[cell.month - 1]}</span>
                    {cell.top ? (
                      <>
                        <Face person={cell.top} />
                        <span className="weq-mo-month-name">{cell.top.peerName}</span>
                        <b className="weq-mo-month-count weq-number">{fmt(cell.top.messages)}</b>
                      </>
                    ) : (
                      <span className="weq-mo-month-quiet" aria-label="这个月很安静">
                        <i aria-hidden />
                      </span>
                    )}
                    {'carried' in cell && cell.carried ? (
                      <span className="weq-mo-month-carried" aria-label="去年同月">
                        去年
                      </span>
                    ) : null}
                  </li>
                ))}
              </ol>
            </section>

            <p className="weq-mo-mood weq-report-line" style={{ '--i': 4 } as CSSProperties}>
              时间会替你筛人——留下来的，是那个总在对话框另一头、从未缺席的人。
            </p>
          </>
        ) : (
          <section className="weq-mo-empty">
            <p>这一年还没有足够多的有来有往，讲不出「谁陪你走过」的故事。</p>
            <p className="weq-mo-empty-sub">故事的第一句，可以从你这里写起。</p>
          </section>
        )}
      </div>
    </PageFrame>
  );
}

/** 名字越长字号越小，始终只占一行。 */
function nameSize(name: string): string {
  const width = [...name].reduce((sum, char) => sum + (/\p{Script=Han}/u.test(char) ? 1 : 0.6), 0);
  if (width > 9) return 'is-xl';
  if (width > 6) return 'is-long';
  return '';
}

/**
 * 榜上一张脸。头像走本机缓存 + CDN 兜底，拿不到就用名字首字顶上。
 * 尺寸交给外层 CSS 通过 `.is-champion` / `.weq-mo-month` 的上下文控制。
 */
function Face({ person, champion = false }: { person: MonthFriendEntry; champion?: boolean }) {
  const url = cachedAvatarUrl(avatarFromUin(person.peerUin));
  const cls = `weq-mo-face${champion ? ' is-champion' : ''}`;
  if (!url) {
    return (
      <span className={`${cls} is-initial`} aria-hidden>
        {person.peerName.slice(0, 1)}
      </span>
    );
  }
  return <img className={cls} src={url} alt="" aria-hidden />;
}
