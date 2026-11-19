import { formatDate, unixDate } from '@weq/time';

/** 从真实范围生成文案，旧报告中冗余的 period 不作为范围依据。 */
export function analysisPeriod(request: {
  scope: { startTime?: number; endTime?: number; messageIds?: readonly string[] };
}): string {
  const { startTime, endTime, messageIds } = request.scope;
  const dates =
    startTime !== undefined || endTime !== undefined
      ? `${startTime === undefined ? '最早' : formatDate(unixDate(startTime))} 至 ${endTime === undefined ? '最新' : formatDate(unixDate(endTime))} · 北京时间`
      : '';
  if (messageIds !== undefined)
    return `已选 ${messageIds.length} 条消息${dates ? ` · ${dates}` : ''}`;
  return dates || '全部本地历史';
}
