import { useEffect, useId, useRef, useState } from 'react';
import { Download, FileCheck2, ShieldCheck, X } from 'lucide-react';
import { Modal } from '../../components/Dialog';
import { Row, Toggle } from '../../components/settings/controls';
import '../../styles/export-report.css';

export function ExportReportControl({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="weq-export-report-option">
      <span className="weq-export-report-option-icon" aria-hidden>
        <FileCheck2 size={18} strokeWidth={1.9} />
      </span>
      <Row
        label="附带完整性报告"
        desc="记录导出范围、媒体补全情况与异常项，生成 JSON 和 HTML 报告。"
        control={
          <Toggle
            label="附带完整性报告"
            checked={checked}
            onChange={onChange}
            disabled={disabled}
          />
        }
      />
    </div>
  );
}

/** 没有配置弹窗的批量入口使用同一份确认面板。取消或卸载时不创建任务。 */
export function useExportReportDialog() {
  const [open, setOpen] = useState(false);
  const [checked, setChecked] = useState(false);
  const resolve = useRef<((value: boolean | null) => void) | null>(null);
  const titleId = useId();
  useEffect(
    () => () => {
      resolve.current?.(null);
      resolve.current = null;
    },
    [],
  );
  function finish(value: boolean | null) {
    const pending = resolve.current;
    resolve.current = null;
    setOpen(false);
    pending?.(value);
  }
  return {
    choose: (): Promise<boolean | null> => {
      if (resolve.current) return Promise.resolve(null);
      setChecked(false);
      setOpen(true);
      return new Promise((done) => {
        resolve.current = done;
      });
    },
    dialog: open ? (
      <Modal
        onClose={() => finish(null)}
        width={420}
        labelledBy={titleId}
        className="weq-export-report-modal"
      >
        <div className="weq-export-report-dialog">
          <header className="weq-export-report-header">
            <span className="weq-export-report-header-icon" aria-hidden>
              <Download size={19} strokeWidth={1.9} />
            </span>
            <div>
              <h3 id={titleId}>导出选项</h3>
              <p>选择随本次导出保存的附加内容。</p>
            </div>
            <button
              type="button"
              className="weq-dialog-x"
              aria-label="关闭"
              onClick={() => finish(null)}
            >
              <X size={16} />
            </button>
          </header>
          <ExportReportControl checked={checked} onChange={setChecked} />
          <p className="weq-export-report-note">
            <ShieldCheck size={14} aria-hidden />
            {checked
              ? '报告只描述本次导出的完整性，不代表已取得全部服务端历史。'
              : '默认不生成报告；需要核对导出结果时建议开启。'}
          </p>
          <div className="weq-export-report-actions">
            <button
              type="button"
              className="weq-export-report-button is-soft"
              onClick={() => finish(null)}
            >
              取消
            </button>
            <button
              type="button"
              className="weq-export-report-button is-primary"
              onClick={() => finish(checked)}
            >
              <Download size={15} />
              开始导出
            </button>
          </div>
        </div>
      </Modal>
    ) : null,
  };
}
