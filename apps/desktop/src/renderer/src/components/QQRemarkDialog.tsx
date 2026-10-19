import { useState } from 'react';
import { X } from 'lucide-react';
import type { RoamingTarget } from '@weq/service';
import { trpc } from '../trpc/client';
import { useQQWriteSession } from '../hooks/useQQWriteSession';
import { Modal, useDialog } from './Dialog';
import { QQWriteResult, QQWriteTextRow } from './QQWriteControls';
import { withQQAccountScope } from './qq-actions/shared';
import '../styles/qq-remark.css';

function QQRemarkDialogBody({ target, onClose }: { target: RoamingTarget; onClose: () => void }) {
  const session = useQQWriteSession(`remark:${target.kind}:${target.conv}`);
  const confirm = useDialog((state) => state.confirm);
  const [dirty, setDirty] = useState(false);
  const state = trpc.account.qqWrite.peerState.useQuery(
    {
      ...session.binding!,
      target:
        target.kind === 'group'
          ? { kind: 'group', groupId: Number(target.conv) }
          : { kind: 'c2c', uid: target.conv },
    },
    { enabled: Boolean(session.binding), staleTime: 0, refetchOnMount: 'always' },
  );
  const friend = trpc.account.qqWrite.friendRemark.useMutation();
  const group = trpc.account.qqWrite.groupRemark.useMutation();
  const label = target.kind === 'group' ? '群备注' : '好友备注';
  async function close() {
    if (session.busy) return;
    if (dirty && !(await confirm('放弃备注修改？', '尚未保存的备注将不会提交到 QQ。'))) return;
    onClose();
  }
  return (
    <Modal
      title={`修改${label}`}
      onClose={() => void close()}
      width={440}
      className="weq-qq-remark-dialog"
      presentation="popover"
    >
      <header className="weq-qq-remark-head">
        <div>
          <strong>修改{label}</strong>
          <span>{target.name}</span>
        </div>
        <button
          type="button"
          className="weq-set-iconbtn"
          title="关闭"
          aria-label="关闭备注编辑"
          disabled={session.busy}
          onClick={() => void close()}
        >
          <X size={18} />
        </button>
      </header>
      <div className="weq-set weq-qq-remark-body">
        {state.error && <p role="alert">{state.error.message}</p>}
        {!session.available && <p role="status">QQ 在线能力未就绪</p>}
        {session.binding && state.isLoading && <p role="status">正在读取备注…</p>}
        {state.data && (
          <QQWriteTextRow
            label={label}
            initial={state.data.remark}
            autoFocus
            onDirtyChange={setDirty}
            disabled={
              !session.available || session.busy || (target.kind === 'c2c' && !state.data.friend)
            }
            onSave={(remark) =>
              session.run(
                (binding) =>
                  target.kind === 'group'
                    ? group.mutateAsync({ ...binding, groupId: Number(target.conv), remark })
                    : friend.mutateAsync({ ...binding, uid: target.conv, remark }),
                async () => {
                  const updated = await state.refetch();
                  if (updated.error) throw updated.error;
                },
              )
            }
          />
        )}
        <QQWriteResult result={session.result} />
      </div>
    </Modal>
  );
}
export const QQRemarkDialog = withQQAccountScope(QQRemarkDialogBody);
