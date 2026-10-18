import { beijingDay, daySeconds } from '../../lib/messageCalendar';

export interface AnalysisScope {
  expectedAccountUin: string;
  expectedAccountConfigId: string;
  startTime?: number;
  endTime?: number;
  messageIds?: string[];
}
type RequestBase = { id: string; scope: AnalysisScope; period: string };
export type AnalysisReportRequest = RequestBase &
  (
    | { kind: 'annual'; year: number }
    | { kind: 'buddy'; peerUid: string; name: string }
    | { kind: 'group'; groupCode: string; name: string }
    | {
        kind: 'member';
        groupCode: string;
        groupName: string;
        memberUid: string;
        memberUin?: string;
        name: string;
      }
  );
export type AnalysisKind = AnalysisReportRequest['kind'];
export type AnalysisTarget =
  | { kind: 'buddy'; peerUid: string }
  | { kind: 'group'; groupCode: string }
  | { kind: 'member'; groupCode: string; memberUid: string; memberUin?: string };
export interface AnalysisToolRequest {
  target: AnalysisTarget;
  messageIds?: string[];
  revision: number;
}
export const ANALYSIS_LABELS: Record<AnalysisKind, string> = {
  annual: '年度报告',
  buddy: '好友分析',
  group: '群聊分析',
  member: '群成员分析',
};

export function analysisDateRange(start: string, end: string) {
  const parse = (day: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('请选择完整日期。');
    const value = daySeconds(day);
    if (!Number.isSafeInteger(value) || value < 0 || beijingDay(new Date(value * 1000)) !== day)
      throw new Error('日期无效。');
    return value;
  };
  const startTime = parse(start),
    endTime = parse(end) + 86400 - 1;
  if (startTime > endTime) throw new Error('开始日期不能晚于结束日期。');
  return { startTime, endTime };
}

export function analysisTitle(request: AnalysisReportRequest): string {
  return request.kind === 'annual'
    ? `${request.period} · 年度报告`
    : `${request.name} · ${ANALYSIS_LABELS[request.kind]}`;
}
