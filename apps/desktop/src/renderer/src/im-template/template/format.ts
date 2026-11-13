// @ts-nocheck
import * as timeFormat from '@weq/time';
import { dateFormatter } from '@weq/time';
export function formatProfileDate(value: string) {
  return dateFormatter.format(new Date(value));
}

/**
 * ISO / 秒级时间串 → zh-CN 年月日；空值、非法值、epoch 及更早一律返回空串。
 *
 * 与 {@link formatProfileDate} 的区别就是这个「空串兜底」：群资料的 `createTime`
 * 经常是空或 0，直接格式化会显示成 `1970/01/01`，比不显示更糟。
 *
 * 群资料面板（GroupInfoPanel）与群名片／资料页（components/groupProfile）
 * 都用它，所以放在这里共用，别在两边各抄一份。
 */
export function formatShortDate(value: string | null | undefined) {
  return value && new Date(value).getTime() > 0 ? timeFormat.formatDateTime(value) : '';
}
