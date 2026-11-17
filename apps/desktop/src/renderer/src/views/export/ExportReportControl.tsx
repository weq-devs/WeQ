import { FileCheck2 } from 'lucide-react';
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
