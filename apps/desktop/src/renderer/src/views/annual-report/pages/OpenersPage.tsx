import { useEffect, useState, type CSSProperties, type ReactElement } from 'react';
import type { OpenerEntry, OpenersPageData } from '@weq/service';
import { isAllTimeYear, reportEraLabel } from '@weq/service/report-time';
import { PageFrame, type ReportPageProps } from '../pageFrame';
import { Odometer } from '../Odometer';
import { avatarFromUin } from '../../../lib/avatarResolver';
import { cachedAvatarUrl } from '../../../lib/avatarCache';

function fmt(n: number): string {
  return new Intl.NumberFormat('zh-CN').format(n);
}

/**
 * 谁先开口 —— 一页关于「主动」的报告。
 *
 * 统计单位是开场（一段持续来往里的第一句话），不是消息条数。整页因此只有一个
 * 主角：你先开口的比例。它用一颗在发丝轨上滑动的星标表达 —— 往「我先」偏一点，
 * 是你更常想到别人；往「TA 先」偏一点，是别人更常想到你。三位朋友不排行、不铺开，
 * 只作为这场开场叙事里的句子收在底部。
 */
export function OpenersPage({
  page,
  data,
  active,
}: ReportPageProps<OpenersPageData>): ReactElement {
  const allTime = isAllTimeYear(data.year);
  const selfPct = Math.round(data.selfRatio * 100);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!active) {
      setOpen(false);
      return undefined;
    }
    const timer = window.setTimeout(() => setOpen(true), 560);
    return () => window.clearTimeout(timer);
  }, [active]);

  const mood =
    selfPct >= 60
      ? '原来，你总是那个先想到别人的人。'
      : selfPct <= 40
        ? '原来，有人总比你先想到你。'
        : '原来，你们总在差不多的时候，想起彼此。';

  // 三位朋友按「这页在讲谁」排序：向哪边倾，就把那边的人先放出来 ——
  // 不是并列的三张卡，是同一句话里的三个角色。
  const cast: Array<{ kind: 'mine' | 'peer' | 'balanced'; entry: OpenerEntry }> = [];
  const seen = new Set<string>();
  const push = (kind: 'mine' | 'peer' | 'balanced', entry: OpenerEntry | null): void => {
    // 样本太少时三位角色可能落在同一个人身上 —— 同一张脸只登场一次，不拆成
    // 三句自相矛盾的话。
    if (entry && !seen.has(entry.peerUid)) {
      seen.add(entry.peerUid);
      cast.push({ kind, entry });
    }
  };
  if (selfPct >= 55) {
    push('mine', data.mostMine);
    push('balanced', data.balanced);
    push('peer', data.mostPeer);
  } else if (selfPct <= 45) {
    push('peer', data.mostPeer);
    push('balanced', data.balanced);
    push('mine', data.mostMine);
  } else {
    push('balanced', data.balanced);
    push('mine', data.mostMine);
    push('peer', data.mostPeer);
  }

  /** 页底每一行是同一句话里的一个角色，用字面排印避免 JSX 文本换行吃掉标点。 */
  const castSay = (role: (typeof cast)[number]): string => {
    const entry = role.entry;
    if (role.kind === 'mine') {
      const minePct = Math.round((entry.selfStarts / entry.totalStarts) * 100);
      return `${entry.peerName}，这 ${fmt(entry.totalStarts)} 场里你先发起 ${fmt(
        entry.selfStarts,
      )} 次（发起率 ${minePct}%）—— 是你一直在把 TA 找回来。`;
    }
    if (role.kind === 'peer') {
      const peerPct = Math.round((entry.peerStarts / entry.totalStarts) * 100);
      return `${entry.peerName}，这 ${fmt(entry.totalStarts)} 场里 TA 先发起 ${fmt(
        entry.peerStarts,
      )} 次（发起率 ${peerPct}%）—— 有人总比你早一步想你。`;
    }
    const minePct = Math.round((entry.selfStarts / entry.totalStarts) * 100);
    const peerPct = 100 - minePct;
    return `${entry.peerName}，开场 ${fmt(entry.selfStarts)} : ${fmt(
      entry.peerStarts,
    )}，发起率 ${minePct}% : ${peerPct}% —— 谁先想起谁，都不算抢先。`;
  };

  const roleLabel = (kind: (typeof cast)[number]['kind']): string =>
    kind === 'mine' ? '你发起占比最高' : kind === 'peer' ? 'TA 发起占比最高' : '最接近 50%';

  return (
    <PageFrame page={page} active={active} ghost="先" ghostPlacement="center" tone="#6b4f8f">
      <div className="weq-op">
        <header className="weq-op-kicker weq-report-line" style={{ '--i': 1 } as CSSProperties}>
          <span>{reportEraLabel(data.year)} · 谁先开口</span>
          <span className="weq-op-kicker-meta">
            <b className="weq-number">{fmt(data.peerCount)}</b> 位朋友
            <i aria-hidden>/</i>
            <b className="weq-number">{fmt(data.totalStarts)}</b> 场开场
          </span>
        </header>

        <section className="weq-op-hero weq-report-line" style={{ '--i': 2 } as CSSProperties}>
          <p className="weq-op-lede">
            {allTime ? '有记录以来' : `这一年`}你一共发起了
            <b className="weq-number">{fmt(data.selfStarts)}</b> 场聊天，占全部开场的
          </p>
          <div className="weq-op-punch">
            <Odometer value={selfPct} active={active} className="weq-op-num" />
            <span className="weq-op-unit">%</span>
            <span className="weq-op-word">是你先开口</span>
          </div>
          <p className="weq-op-mood">{mood}</p>
        </section>

        <section
          className="weq-op-beam weq-report-line"
          data-open={open ? 'yes' : 'no'}
          style={{ '--i': 3 } as CSSProperties}
        >
          <span className="weq-op-beam-side is-peer">
            TA 先开口 <b className="weq-number">{fmt(data.peerStarts)}</b>
          </span>
          <div className="weq-op-beam-track" aria-hidden>
            <i className="weq-op-beam-half is-peer" />
            <i className="weq-op-beam-half is-mine" />
            <i className="weq-op-beam-mid" />
            <span className="weq-op-beam-dot" style={{ '--pos': selfPct } as CSSProperties}>
              <b />
            </span>
          </div>
          <span className="weq-op-beam-side is-mine">
            <b className="weq-number">{fmt(data.selfStarts)}</b> 我先开口
          </span>
        </section>

        {cast.length > 0 ? (
          <section className="weq-op-cast weq-report-line" style={{ '--i': 4 } as CSSProperties}>
            <p className="weq-op-cast-in">而这些朋友，把「先开口」写成了不同的样子——</p>
            <div className="weq-op-cast-row">
              {cast.map((role, index) => (
                <article
                  className={`weq-op-person is-${role.kind}`}
                  key={`${role.kind}:${role.entry.peerUid}`}
                  style={{ '--j': index } as CSSProperties}
                >
                  <Face name={role.entry.peerName} uin={role.entry.peerUin} />
                  <b className="weq-op-person-name">{role.entry.peerName}</b>
                  <span className="weq-op-line-role">{roleLabel(role.kind)}</span>
                  <p className="weq-op-person-say">
                    <NameSay
                      name={role.entry.peerName}
                      text={personSay(role.entry.peerName, castSay(role))}
                    />
                  </p>
                </article>
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </PageFrame>
  );
}

/** 名字染成页色、其余保持正文 —— 一整句里只有人是彩色的。 */
function NameSay({ name, text }: { name: string; text: string }): ReactElement {
  const [head, ...rest] = text.split(name);
  return (
    <>
      {head}
      <em>{name}</em>
      {rest.join(name)}
    </>
  );
}

/**
 * 开场里的人。头像照旧走本机缓存 + CDN 兜底，拿不到就用首字顶上 ——
 * 一句话的排印里不能留空洞。
 */
function Face({ name, uin }: { name: string; uin: string }): ReactElement {
  const url = cachedAvatarUrl(avatarFromUin(uin));
  if (!url) {
    return (
      <span className="weq-op-face is-initial" aria-hidden>
        {name.slice(0, 1)}
      </span>
    );
  }
  return <img className="weq-op-face" src={url} alt="" aria-hidden />;
}

/**
 * castSay 的旧句子以名字开头，人物卡里名字已单独展示，去掉开头的名字与
 * 紧随的逗号，避免一句里出现两次称呼。
 */
function personSay(name: string, text: string): string {
  const prefix = `${name}，`;
  return text.startsWith(prefix) ? text.slice(prefix.length) : text;
}
