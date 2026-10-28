import { useEffect, useId, useRef, useState } from 'react';
import { Download, X } from 'lucide-react';
import { Modal } from '../../components/Dialog';
import { Row, Toggle } from '../../components/settings/controls';

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
    <Row
      label="附带完整性报告"
      control={
        <Toggle label="附带完整性报告" checked={checked} onChange={onChange} disabled={disabled} />
      }
    />
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
      <Modal onClose={() => finish(null)} width={400} labelledBy={titleId}>
        <div className="weq-message-calendar">
          <header>
            <h3 id={titleId}>导出选项</h3>
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
          <div className="weq-dialog-actions">
            <button type="button" className="weq-action-soft" onClick={() => finish(null)}>
              取消
            </button>
            <button type="button" className="weq-action-primary" onClick={() => finish(checked)}>
              <Download size={15} />
              开始导出
            </button>
          </div>
        </div>
      </Modal>
    ) : null,
  };
}
