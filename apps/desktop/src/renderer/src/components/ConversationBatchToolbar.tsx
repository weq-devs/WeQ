import type { Conversation } from '../im-template/template/types';
import { useContext } from 'react';
import { ConversationDirectoryContext } from '../lib/conversationDirectory';
import { ConversationSelectionToolbar } from './ConversationSelectionToolbar';
import { useConversationBatchActions } from './useConversationBatchActions';

/** 联系人与会话列表共用同一套可用性判断和批量操作。 */
export function ConversationBatchToolbar({
  conversations,
  ids,
  busy = false,
}: {
  conversations: Conversation[];
  ids: string[];
  busy?: boolean;
}) {
  const directory = useContext(ConversationDirectoryContext);
  const batch = useConversationBatchActions(conversations);
  const reason = busy ? '正在补齐全选' : !ids.length ? '请先选择会话' : undefined;
  return (
    <>
      <ConversationSelectionToolbar
        exportReason={reason ?? (!batch.exportAvailable ? '当前无法导出会话' : undefined)}
        roamingReason={reason ?? (!batch.roamingAvailable ? '当前无法拉取漫游消息' : undefined)}
        rosterReason={
          reason ??
          (!batch.exportAvailable
            ? '当前无法导出名单'
            : !batch.rosterIds(ids).length
              ? '请先选择群聊'
              : undefined)
        }
        readStateReason={
          reason ??
          (!directory?.onReadState
            ? '当前无法标记已读'
            : directory.readStateBusy
              ? '正在更新标记'
              : ids.length > 4096
                ? '一次最多标记 4096 个会话'
                : undefined)
        }
        onExport={() => batch.runExport(ids)}
        onRoaming={() => batch.runRoaming(ids)}
        onRoster={() => batch.runRoster(ids)}
        onReadState={() => batch.runReadState(ids, false)}
      />
      {batch.confirmation}
    </>
  );
}
