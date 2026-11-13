import { Loader2, RotateCw } from 'lucide-react';
import { trpc } from '../../trpc/client';
import { GroupAnnouncementsDialog } from '../GroupAnnouncementsDialog';
import { GroupEssenceDialog } from '../GroupEssenceDialog';
import type { ContentSearchTarget } from './types';

export function SearchGroupContentResult({
  target,
  onClose,
  onJump,
}: {
  target: Extract<ContentSearchTarget, { kind: 'groupBulletin' | 'groupEssence' }> & {
    expectedAccountUin: string;
    expectedAccountConfigId: string;
  };
  onClose: () => void;
  onJump: (groupCode: string, seq: number) => void;
}) {
  const input = {
    ...target,
    id: target.kind === 'groupBulletin' ? target.bulletinId : target.msgSeq,
  };
  const query = trpc.account.searchTargets.group.useQuery(input, {
    retry: false,
    refetchOnWindowFocus: false,
  });
  if (query.data?.kind === 'bulletin')
    return (
      <GroupAnnouncementsDialog
        embedded
        groupCode={target.groupCode}
        groupName={query.data.name}
        bulletins={[query.data.bulletin]}
        initialNoticeId={input.id}
        onClose={onClose}
      />
    );
  if (query.data?.kind === 'essence') {
    const row = query.data.message;
    return (
      <GroupEssenceDialog
        embedded
        groupCode={target.groupCode}
        groupName={query.data.name}
        initialMsgSeq={row.msgSeq}
        essenceMessages={[
          {
            id: `search:${row.msgSeq}`,
            msgSeq: row.msgSeq,
            msgRandom: row.msgRandom,
            senderName: row.senderNick,
            operatorName: row.operatorNick,
            createdAt: new Date(row.operatorTime * 1000).toISOString(),
            active: true,
            content: row.content,
            senderTime: row.senderTime,
            canRemove: row.canRemove,
          },
        ]}
        onClose={onClose}
        onJumpToMessage={(seq) => onJump(target.groupCode, seq)}
      />
    );
  }
  return (
    <div className="weq-search-content-state">
      {query.error ? (
        <>
          <p role="alert">{query.error.message}</p>
          <button type="button" className="weq-set-btn" onClick={() => void query.refetch()}>
            <RotateCw size={16} />
            重试
          </button>
        </>
      ) : (
        <p role="status">
          <Loader2 className="weq-spin" size={18} />
          正在读取对应内容
        </p>
      )}
    </div>
  );
}
