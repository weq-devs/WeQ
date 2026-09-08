import type { CSSProperties, ReactElement } from 'react';
import type { MatePageData } from '@weq/service';
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

/**
 * 还没加好友的同路人 —— 一页关于「圈子里的重逢」。
 *
 * 主体只有一个人：加权重合最高的非好友。TA 的头像顶到版心，光环由一圈
 * 慢慢游走的粒子围成 —— 每个粒子都是一次「在某个群里遇见」。TA 的名字和
 * 「N 个群」的巨数压住画面，共同群的名单收在脚下一行，不是又一张排行榜。
 * 冠军之外再补几位小一号的推荐，让「可以扩列」不只停在一个人身上。
 */
export function MatePage({ page, data, active }: ReportPageProps<MatePageData>): ReactElement {
  const top = data.top;

  return (
    <PageFrame page={page} active={active} ghost="缘" tone="#3e7f77">
      <div className="weq-mt" data-has-top={top ? 'yes' : 'no'}>
        <header className="weq-mt-kicker weq-report-line" style={{ '--i': 1 } as CSSProperties}>
          <span>{reportEraLabel(data.year)} · 还没加好友的同路人</span>
          <span className="weq-mt-kicker-meta">
            <b className="weq-number">{fmt(data.groupCount)}</b> 个群
            <i aria-hidden>/</i>
            <b className="weq-number">{fmt(data.personCount)}</b> 位未加好友的群友
          </span>
        </header>

        {top ? (
          <>
            <div className="weq-mt-orbit" data-enter={active ? 'in' : 'out'} aria-hidden>
              <i className="weq-mt-ring is-a" />
              <i className="weq-mt-ring is-b" />
              {Array.from({ length: ORBIT_NODES }, (_, index) => (
                <i
                  // biome-ignore lint/suspicious/noArrayIndexKey: 粒子是静态装饰，列表永不变。
                  key={index}
                  className="weq-mt-node"
                  style={{ '--n': index, '--k': index % 2 } as CSSProperties}
                />
              ))}
            </div>

            <section className="weq-mt-hero">
              <p className="weq-mt-lede weq-report-line" style={{ '--i': 2 } as CSSProperties}>
                有些人你以为不认识，其实已经在群里见过很多面了——
              </p>
              <div
                className="weq-mt-face-wrap weq-report-line"
                style={{ '--i': 3 } as CSSProperties}
              >
                <Face name={top.name} uin={top.uin} />
              </div>
              <h2
                className={`weq-mt-name ${nameSize(top.name)}`}
                style={{ '--i': 4 } as CSSProperties}
              >
                {top.name}
              </h2>
              <p className="weq-mt-countline weq-report-line" style={{ '--i': 5 } as CSSProperties}>
                <Odometer
                  value={top.sharedCount}
                  active={active}
                  className="weq-mt-count"
                  durationMs={1800}
                />
                <span className="weq-mt-unit" aria-hidden>
                  <b>个群</b>
                  <i>里有 TA</i>
                </span>
              </p>
              <p className="weq-mt-note weq-report-line" style={{ '--i': 6 } as CSSProperties}>
                你们还没有加好友——但同一个圈子里，已经重逢了{' '}
                <b className="weq-number">{fmt(top.sharedCount)}</b> 次。
              </p>
            </section>

            <section
              className="weq-mt-cluster weq-report-line"
              style={{ '--i': 7 } as CSSProperties}
            >
              <p className="weq-mt-cluster-in">这些群，就是 TA 的「生态位」</p>
              <p className="weq-mt-chips">
                {top.groups.slice(0, HERO_GROUPS_SHOW).map((group, index) => (
                  <span className="weq-mt-chip" key={group.groupCode}>
                    <i aria-hidden>{String(index + 1).padStart(2, '0')}</i>
                    {group.groupName}
                  </span>
                ))}
                {top.sharedCount > top.groups.length ? (
                  <span className="weq-mt-chip is-more">
                    +{fmt(top.sharedCount - top.groups.length)}
                  </span>
                ) : null}
              </p>
            </section>

            {data.more.length > 0 ? (
              <ol className="weq-mt-more weq-report-line" style={{ '--i': 8 } as CSSProperties}>
                {data.more.map((candidate, index) => (
                  <li className="weq-mt-more-item" key={candidate.uid || candidate.uin}>
                    <span className="weq-mt-more-rank" aria-hidden>
                      0{index + 2}
                    </span>
                    <Face name={candidate.name} uin={candidate.uin} />
                    <span className="weq-mt-more-name">{candidate.name}</span>
                    <span className="weq-mt-more-track" aria-hidden>
                      <i
                        style={{
                          width: `${Math.max(
                            16,
                            Math.round(
                              (candidate.sharedCount / Math.max(1, top.sharedCount)) * 100,
                            ),
                          )}%`,
                        }}
                      />
                    </span>
                    <b className="weq-mt-more-val weq-number">{fmt(candidate.sharedCount)}</b>
                    <i className="weq-mt-more-unit">个群</i>
                  </li>
                ))}
              </ol>
            ) : null}

            <p className="weq-mt-mood weq-report-line" style={{ '--i': 9 } as CSSProperties}>
              世界很大，圈子很小。同频的人值得一句「你好」——也许加了好友以后，你们会更熟。
            </p>
          </>
        ) : (
          <section className="weq-mt-empty">
            <p>在这些群里，还没有一个值得专门加好友的「重逢」。</p>
            <p className="weq-mt-empty-sub">多待几个感兴趣的圈子，同频的人自然会再出现。</p>
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
