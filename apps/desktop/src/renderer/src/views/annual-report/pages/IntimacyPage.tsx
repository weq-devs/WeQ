import type { ReactElement } from 'react';
import { Heart } from 'lucide-react';
import type { IntimacyPageData } from '@weq/service';
import { PageFrame, type ReportPageProps } from '../pageFrame';

/**
 * 亲密度最高的好友 — the single fully-wired annual-report demo page.
 *
 * `IntimacyPageData` is type-only imported from `@weq/service` so this component
 * shares one data contract with the service-side compute; a field rename there
 * fails this typecheck instead of crashing at runtime.
 */
export function IntimacyPage({ page, data }: ReportPageProps<IntimacyPageData>): ReactElement {
  const { minScore, friends } = data;
  return (
    <PageFrame page={page}>
      {friends.length === 0 ? (
        <p className="weq-report-intimacy-empty">没有亲密度 ≥ {minScore} 的好友。</p>
      ) : (
        <ol className="weq-report-intimacy-list" aria-label="亲密度排行">
          {friends.map((friend, index) => (
            <li className="weq-report-intimacy-item" key={friend.uid}>
              <span className="weq-report-intimacy-rank">{index + 1}</span>
              <div className="weq-report-intimacy-body">
                <span className="weq-report-intimacy-name">
                  {friend.remark || friend.nick || '好友'}
                </span>
                <span className="weq-report-intimacy-meta">
                  {friend.nick && friend.remark ? `${friend.nick} · ` : ''}
                  QQ {friend.uin || friend.uid}
                </span>
              </div>
              <span className="weq-report-intimacy-score" title={`亲密度 ${friend.intimacy}`}>
                <Heart size={13} aria-hidden />
                {friend.intimacy.toLocaleString('zh-CN')}
              </span>
            </li>
          ))}
        </ol>
      )}
    </PageFrame>
  );
}
