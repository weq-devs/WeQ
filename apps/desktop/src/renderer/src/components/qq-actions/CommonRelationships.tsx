import { useState } from 'react';
import { UsersRound, X, RefreshCw } from 'lucide-react';
import { trpc } from '../../trpc/client';
import { useQQWriteSession } from '../../hooks/useQQWriteSession';
import { Modal } from '../Dialog';
import { withQQAccountScope } from './shared';

function CommonRelationshipsBody({ uin }: { uin: string }) {
  const session = useQQWriteSession(`common-relationships:${uin}`);
  const [open, setOpen] = useState(false);
  const query = trpc.account.qqWrite.commonRelationships.useQuery(
    { ...session.binding!, target: uin },
    {
      enabled:
        session.available &&
        /^[1-9]\d{4,9}$/.test(uin) &&
        uin !== session.binding?.expectedAccountUin,
      retry: false,
      staleTime: 60000,
      refetchOnWindowFocus: false,
    },
  );
  if (uin === session.binding?.expectedAccountUin) return null;
  return (
    <div className="weq-common-relations">
      <span>
        共同好友 <strong>{query.data?.friendCount ?? (query.isFetching ? '…' : '未知')}</strong>
      </span>
      <button
        type="button"
        disabled={!query.data?.groups}
        onClick={() => setOpen(true)}
        title="查看共同群列表"
      >
        共同群 <strong>{query.data?.groups?.length ?? (query.isFetching ? '…' : '未知')}</strong>
      </button>
      {(query.error || query.data?.friendError || query.data?.groupError) && (
        <button
          type="button"
          title="重新读取共同关系"
          aria-label="重新读取共同关系"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          <RefreshCw size={14} />
        </button>
      )}
      {open && (
        <Modal
          centered
          width={400}
          title="共同群"
          onClose={() => setOpen(false)}
          className="weq-friend-directory-editor"
        >
          <header>
            <h3>共同群</h3>
            <button type="button" title="关闭" aria-label="关闭" onClick={() => setOpen(false)}>
              <X size={18} />
            </button>
          </header>
          {!query.data?.groups?.length && <p>暂无共同群</p>}
          <ul>
            {query.data?.groups?.map((group) => (
              <li key={group.groupCode}>
                <UsersRound size={16} />
                <span>
                  {group.name || group.groupCode}
                  <small>{group.groupCode}</small>
                </span>
              </li>
            ))}
          </ul>
        </Modal>
      )}
    </div>
  );
}
export const CommonRelationships = withQQAccountScope(CommonRelationshipsBody);
