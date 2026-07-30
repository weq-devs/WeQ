/**
 * 临时会话灰条 (GRAY_TIP subType=15 / GrayTipSubType.AIO_OP).
 *
 * QQ renders these as 「该用户通过 xxx 群聊向你发起临时会话」. Always the first
 * message (seq=1) of a c2c conversation with a non-friend, with an empty
 * row-level sender.
 *
 * `tempSessionGroupCode` (wire tag 47502) is the SOURCE GROUP's code, not the
 * peer's uin — verified against group_msg_table, where every observed value has
 * real group history and none matches the peer's own uin.
 *
 * The group name comes from `listAllGroups`, which MainView already queries with
 * the same input; react-query dedupes them, so this costs no extra fetch.
 */

import { trpc } from '../trpc/client';

interface GrayTipTempSessionMessageProps {
  element: {
    type: 'grayTipTempSession';
    data?: {
      tempSessionGroupCode?: string;
    };
  };
}

export function GrayTipTempSessionMessage({ element }: GrayTipTempSessionMessageProps) {
  const { tempSessionGroupCode } = element.data || {};
  const allGroups = trpc.account.listAllGroups.useQuery({ limit: 2000 });

  if (!tempSessionGroupCode) return null;

  const group = (allGroups.data ?? []).find(
    (g) => String((g as { groupCode?: unknown }).groupCode) === tempSessionGroupCode,
  );
  // Groups we've since left aren't in the list — fall back to the bare code.
  const label = (group as { groupName?: string } | undefined)?.groupName || tempSessionGroupCode;

  return (
    <div className="weq-graytip text-center text-gray-500 text-xs py-2">
      <span>该用户通过 </span>
      <span className="text-blue-500">{label}</span>
      <span className="px-1">群聊向你发起临时会话</span>
    </div>
  );
}
