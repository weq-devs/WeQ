import { NumericText } from '../../components/NumericText';
import { useId, useRef } from 'react';
import { Modal } from '../../components/Dialog';
import { useViewState } from '../../state/view';
import { AnnualReportView } from '../annual-report/AnnualReportView';
import { analysisTitle, type AnalysisReportRequest } from './model';
import { SavedAnalysisBody } from './SavedAnalysisBody';
import '../../styles/analysis-tool.css';
import '../../styles/page-shell.css';
import '../../styles/workspace-tools.css';
import { BarChart3, Users, UserRound, X } from 'lucide-react';

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
  const titleId = useId();
  const closeRequest = useRef<(() => void) | null>(null);
  const close = () => (closeRequest.current ?? onClose)();
  if (account !== request.scope.expectedAccountUin) return null;
  return (
    <Modal
      presentation="modal"
      width={1000}
      className="weq-tools-modal"
      labelledBy={titleId}
      dismissOnOutside={false}
      onClose={close}
    >
      <section className="weq-analysis-result">
        <header className="weq-analysis-result-head">
          <span className="weq-analysis-result-glyph" aria-hidden>
            {(() => {
              const Icon = REPORT_ICONS[request.kind] ?? BarChart3;
              return <Icon size={16} />;
            })()}
          </span>
          <span className="weq-analysis-result-title">
            <strong id={titleId}>{analysisTitle(request)}</strong>
            {request.kind === 'annual' ? (
              <small>{request.period} · 年度报告</small>
            ) : request.kind === 'member' ? (
              <small>
                {request.groupName}（<NumericText>{request.groupCode}</NumericText>）
              </small>
            ) : null}
          </span>
          <button
            type="button"
            className="weq-page-close"
            onClick={close}
            title="关闭分析报告"
            aria-label="关闭分析报告"
          >
            <X size={18} />
          </button>
        </header>
        <div className="weq-analysis-result-body">
          {request.kind === 'annual' ? (
            <AnnualReportView
              configuredYear={request.year}
              scope={request.scope}
              instanceKey={request.id}
            />
          ) : (
            <SavedAnalysisBody
              key={request.id}
              request={request}
              onClose={onClose}
              closeRequest={closeRequest}
            />
          )}
        </div>
      </section>
    </Modal>
  );
}
