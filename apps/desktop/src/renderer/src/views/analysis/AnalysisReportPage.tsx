import { WorkspacePage } from '../../components/WorkspacePages';
import { BuddyAnalyticsDialog } from '../../components/BuddyAnalyticsDialog';
import { GroupAnalyticsDialog } from '../../components/GroupAnalyticsDialog';
import { MemberAnalyticsDialog } from '../../components/MemberAnalyticsDialog';
import { useViewState } from '../../state/view';
import { AnnualReportView } from '../annual-report/AnnualReportView';
import { analysisTitle, type AnalysisReportRequest } from './model';
import '../../styles/analysis-tool.css';
import { BarChart3, Users, UserRound } from 'lucide-react';

/** 年度报告只作旧请求的兼容渲染（新入口在侧栏「年度报告」）。 */
const REPORT_ICONS = {
  annual: BarChart3,
  buddy: UserRound,
  group: Users,
  member: Users,
} as const;

export function AnalysisReportPage({
  request,
  onClose,
}: {
  request: AnalysisReportRequest;
  onClose: () => void;
}) {
  const account = useViewState((state) => state.openedUin);
  if (account !== request.scope.expectedAccountUin) return null;
  return (
    <WorkspacePage title={analysisTitle(request)} onClose={onClose}>
      <section className="weq-analysis-result">
        <header className="weq-analysis-result-head">
          <span className="weq-analysis-result-glyph" aria-hidden>
            {(() => {
              const Icon = REPORT_ICONS[request.kind] ?? BarChart3;
              return <Icon size={16} />;
            })()}
          </span>
          <span className="weq-analysis-result-title">
            <strong>{analysisTitle(request)}</strong>
            <small>
              {request.period}
              {request.kind === 'annual' ? ' · 年度报告' : ''}
            </small>
          </span>
        </header>
        <div className="weq-analysis-result-body">
          {request.kind === 'annual' ? (
            <AnnualReportView
              configuredYear={request.year}
              scope={request.scope}
              instanceKey={request.id}
            />
          ) : request.kind === 'buddy' ? (
            <BuddyAnalyticsDialog
              peerUid={request.peerUid}
              peerName={request.name}
              scope={request.scope}
              embedded
              onClose={onClose}
            />
          ) : request.kind === 'group' ? (
            <GroupAnalyticsDialog
              groupCode={request.groupCode}
              groupName={request.name}
              scope={request.scope}
              embedded
              onClose={onClose}
            />
          ) : (
            <MemberAnalyticsDialog
              groupCode={request.groupCode}
              groupName={request.groupName}
              member={{ uid: request.memberUid, uin: request.memberUin, name: request.name }}
              scope={request.scope}
              embedded
              onClose={onClose}
            />
          )}
        </div>
      </section>
    </WorkspacePage>
  );
}
