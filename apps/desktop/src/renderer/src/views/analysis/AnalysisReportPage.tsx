import { WorkspacePage } from '../../components/WorkspacePages';
import { BuddyAnalyticsDialog } from '../../components/BuddyAnalyticsDialog';
import { GroupAnalyticsDialog } from '../../components/GroupAnalyticsDialog';
import { MemberAnalyticsDialog } from '../../components/MemberAnalyticsDialog';
import { useViewState } from '../../state/view';
import { AnnualReportView } from '../annual-report/AnnualReportView';
import { analysisTitle, type AnalysisReportRequest } from './model';
import '../../styles/analysis-tool.css';
import { X } from 'lucide-react';

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
        {request.kind === 'annual' ? (
          <header className="weq-tools-header">
            <h2>{analysisTitle(request)}</h2>
            <button type="button" title="关闭报告" aria-label="关闭报告" onClick={onClose}>
              <X size={18} />
            </button>
          </header>
        ) : null}
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
              periodLabel={request.period}
              embedded
              onClose={onClose}
            />
          ) : request.kind === 'group' ? (
            <GroupAnalyticsDialog
              groupCode={request.groupCode}
              groupName={request.name}
              scope={request.scope}
              periodLabel={`${request.period} · 成员资料：当前本地缓存`}
              embedded
              onClose={onClose}
            />
          ) : (
            <MemberAnalyticsDialog
              groupCode={request.groupCode}
              groupName={request.groupName}
              member={{ uid: request.memberUid, uin: request.memberUin, name: request.name }}
              scope={request.scope}
              periodLabel={`${request.period} · 成员资料：当前本地缓存`}
              embedded
              onClose={onClose}
            />
          )}
        </div>
      </section>
    </WorkspacePage>
  );
}
