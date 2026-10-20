import { reportPeriodLabel } from '@weq/service/report-time';

export function annualReportExportOutput(year: number, extension: 'html' | 'pdf' | 'png') {
  return {
    kind: 'file' as const,
    name: `QQ年度报告_${reportPeriodLabel(year)}${extension === 'png' ? '_长图' : ''}`,
    extension,
  };
}
