import { Modal } from './Dialog';
import { chooseDraft, useDraftConflict } from '../lib/draftConflicts';
import { useState, useEffect, type ReactNode } from 'react';
import { Download, FileText, Trash2, X } from 'lucide-react';
import { LoadingIndicator } from './LoadingIndicator';
import { client, trpc } from '../trpc/client';
import { accountBinding, useClientPreferences } from '../lib/clientPreferences';
import { useAppDialog } from '../lib/dialogUtils';

function preview(value: unknown) {
  return typeof value === 'string'
    ? value
    : value === null
      ? '空草稿'
      : JSON.stringify(value, null, 2);
}
function DraftModal({
  title,
  id,
  onClose,
  children,
}: {
  title: string;
  id: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Modal labelledBy={id} onClose={onClose} centered width={560} className="weq-message-modal">
      <div className="weq-dialog weq-dialog-info">
        <div className="weq-dialog-head">
          <span className="weq-dialog-icon">
            <FileText size={20} aria-hidden />
          </span>
          <h3 id={id} className="weq-dialog-title">
            {title}
          </h3>
          <button type="button" className="weq-dialog-x" aria-label="关闭" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="weq-dialog-body">{children}</div>
      </div>
    </Modal>
  );
}
export function DraftConflictHost() {
  useClientPreferences((state) => state.tick);
  const binding = accountBinding();
  const [opened, setOpened] = useState(false);
  const [detail, setDetail] = useState<{ key: string; value: unknown } | null>(null);
  const [error, setError] = useState('');
  const dialog = useAppDialog();
  const utils = trpc.useUtils();
  const copies = trpc.clientState.draftCopies.useQuery(
    binding ?? { expectedAccountUin: '', expectedAccountConfigId: '' },
    { enabled: Boolean(binding) },
  );
  const conflict = useDraftConflict((state) => state.requests[0]);
  const copiesOpen = useDraftConflict((state) => state.copiesOpen);
  useEffect(() => {
    useDraftConflict.setState({ copiesCount: copies.data?.length ?? 0 });
  }, [copies.data]);
  useEffect(() => {
    if (copiesOpen) setOpened(true);
  }, [copiesOpen]);
  if (!conflict)
    return (
      <>
        {opened && (
          <DraftModal title="草稿副本" id="weq-draft-copies-title" onClose={() => setOpened(false)}>
            <div className="weq-draft-conflict">
              {!copies.data && copies.isFetching && <LoadingIndicator />}
              {error && <p role="alert">{error}</p>}
              {(copies.data ?? []).map((copy) => (
                <div key={copy.key}>
                  <label htmlFor={copy.key}>冲突副本</label>
                  <textarea
                    data-privacy-sensitive
                    id={copy.key}
                    readOnly
                    value={preview(detail?.key === copy.key ? detail.value : copy.value)}
                  />
                  <div className="weq-draft-conflict-actions">
                    <button
                      type="button"
                      className="weq-set-btn"
                      onClick={() => {
                        if (!binding) return;
                        void client.clientState.draft
                          .query({ ...binding, key: copy.key })
                          .then((draft) => setDetail({ key: copy.key, value: draft.value }))
                          .catch((error) => setError(String(error)));
                      }}
                    >
                      <FileText size={14} />
                      查看全文
                    </button>
                    <button
                      type="button"
                      className="weq-set-btn"
                      onClick={async () => {
                        if (!binding) return;
                        try {
                          const draft = await client.clientState.draft.query({
                            ...binding,
                            key: copy.key,
                          });
                          const url = URL.createObjectURL(
                            new Blob([JSON.stringify(draft.value, null, 2)], {
                              type: 'application/json',
                            }),
                          );
                          const anchor = document.createElement('a');
                          anchor.href = url;
                          anchor.download = 'weq-draft-copy.json';
                          anchor.click();
                          setTimeout(() => URL.revokeObjectURL(url), 1000);
                        } catch (error) {
                          setError(String(error));
                        }
                      }}
                    >
                      <Download size={14} />
                      导出副本
                    </button>
                    <button
                      type="button"
                      className="weq-set-btn"
                      onClick={async () => {
                        if (
                          !binding ||
                          !(await dialog.confirm(
                            '删除草稿副本',
                            '将删除此副本，原共享草稿保持不变。',
                            { okLabel: '删除', tone: 'warning' },
                          ))
                        )
                          return;
                        try {
                          const result = await client.clientState.saveDraft.mutate({
                            ...binding,
                            key: copy.key,
                            value: null,
                            expectedVersion: copy.version,
                          });
                          if (!result.ok) throw new Error('副本已变化，请重新读取后重试');
                          await utils.clientState.draftCopies.invalidate();
                        } catch (error) {
                          setError(String(error));
                        }
                      }}
                    >
                      <Trash2 size={14} />
                      删除
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </DraftModal>
        )}
      </>
    );
  return (
    <DraftModal
      title="发现另一份草稿"
      id="weq-draft-conflict-title"
      onClose={() => chooseDraft('cancel')}
    >
      <div className="weq-draft-conflict">
        <label>
          本机内容
          <textarea data-privacy-sensitive readOnly value={preview(conflict.local)} />
        </label>
        <label>
          共享内容
          <textarea data-privacy-sensitive readOnly value={preview(conflict.remote.value)} />
        </label>
        <div className="weq-draft-conflict-actions">
          <button type="button" className="weq-set-btn" onClick={() => chooseDraft('local')}>
            保留本机并覆盖共享
          </button>
          <button type="button" className="weq-set-btn" onClick={() => chooseDraft('remote')}>
            使用共享稿
          </button>
          <button type="button" className="weq-set-btn" onClick={() => chooseDraft('copy')}>
            另存副本
          </button>
        </div>
      </div>
    </DraftModal>
  );
}
