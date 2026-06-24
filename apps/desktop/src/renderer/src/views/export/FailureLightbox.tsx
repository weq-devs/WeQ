/**
 * 媒体补全失败详情灯箱。列出每个补全失败的文件（图片 / 视频 / 文件）及失败原因，
 * 供用户排查为何某些缺失媒体没能从云端补全。只读，无确认动作。
 */

import { useMemo, useState, type ReactElement } from 'react';
import { FileWarning, X } from 'lucide-react';
import { closeFromScrim, useEscapeToClose } from '../../im-template/template/modalUtils';
import type { UiFailure } from './TaskList';

/** Stage key → 中文标签（用于分组标题与筛选）。 */
const STAGE_LABEL: Record<string, string> = {
  image: '图片',
  video: '视频',
  file: '文件',
  media: '搬运',
  record: '语音',
};

function stageLabel(stage: string): string {
  return STAGE_LABEL[stage] ?? stage;
}

export function FailureLightbox({
  taskName,
  failures,
  onClose,
}: {
  taskName: string;
  failures: UiFailure[];
  onClose: () => void;
}): ReactElement {
  useEscapeToClose(onClose);

  // 各类型可用作筛选 chip：'all' + 出现过的 stage。
  const stages = useMemo(() => {
    const seen: string[] = [];
    for (const f of failures) if (!seen.includes(f.stage)) seen.push(f.stage);
    return seen;
  }, [failures]);
  const [filter, setFilter] = useState<string>('all');

  const shown = filter === 'all' ? failures : failures.filter((f) => f.stage === filter);

  return (
    <div className="modal-scrim weq-exp-modal-scrim" role="presentation" onMouseDown={closeFromScrim(onClose)}>
      <section className="weq-exp-dialog weq-exp-fail-dialog" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
        <header className="weq-exp-dialog-head">
          <div className="weq-exp-dialog-title">
            <strong>媒体补全失败详情</strong>
            <span title={taskName}>{taskName} · 共 {failures.length} 个失败</span>
          </div>
          <button type="button" className="weq-exp-dialog-close" onClick={onClose} title="关闭">
            <X size={18} />
          </button>
        </header>

        {stages.length > 1 ? (
          <div className="weq-exp-fail-filters">
            <button
              type="button"
              className={`weq-exp-fail-chip${filter === 'all' ? ' is-active' : ''}`}
              onClick={() => setFilter('all')}
            >
              全部 {failures.length}
            </button>
            {stages.map((s) => (
              <button
                key={s}
                type="button"
                className={`weq-exp-fail-chip${filter === s ? ' is-active' : ''}`}
                onClick={() => setFilter(s)}
              >
                {stageLabel(s)} {failures.filter((f) => f.stage === s).length}
              </button>
            ))}
          </div>
        ) : null}

        <div className="weq-exp-dialog-body weq-exp-fail-body">
          {shown.length === 0 ? (
            <div className="weq-exp-fail-empty">没有失败项</div>
          ) : (
            <ul className="weq-exp-fail-list">
              {shown.map((f, i) => (
                <li key={`${f.stage}-${f.fileName}-${i}`} className="weq-exp-fail-row">
                  <FileWarning size={15} className="weq-exp-fail-icon" aria-hidden />
                  <div className="weq-exp-fail-main">
                    <span className="weq-exp-fail-name" title={f.fileName}>
                      <span className="weq-exp-fail-tag">{stageLabel(f.stage)}</span>
                      {f.fileName}
                    </span>
                    <span className="weq-exp-fail-err" title={f.error}>{f.error}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <footer className="weq-exp-dialog-foot">
          <button type="button" className="weq-exp-btn" onClick={onClose}>
            关闭
          </button>
        </footer>
      </section>
    </div>
  );
}
