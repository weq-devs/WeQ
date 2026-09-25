/**
 * MergeForwardLibraryDialog —— 合并转发的使用场景之二：左栏「更多 → 合成聊天记录」。
 *
 * 这里就是「合成聊天列表」：用户离线时（或想先拼好再发）把聊天记录拼成草稿存在
 * weq 目录，下次继续编辑。点「新建」给一张**空白卡片**，进入 {@link MergeForwardDialog}
 * 的编辑器 —— 发送人可以在**全部好友 + 跨群群友**里搜，也可以直接填 QQ 号 + 昵称。
 *
 * 发送同样要求 QQ 在线：不在线时只能保存草稿。
 */

import { useMemo, useState, type ReactElement } from 'react';
import { FilePlus2, Layers, Pencil, Trash2, X } from 'lucide-react';
import { trpc } from '../../trpc/client';
import { useToast } from '../Toast';
import { Modal } from '../Dialog';
import { MergeForwardDialog } from './MergeForwardDialog';
import { coerceDraft, createEmptyDraft, draftTitle, type MfDraft, type MfTarget } from './model';
import type { MfPerson } from './SenderPicker';

export function MergeForwardLibraryDialog({
  self,
  targets,
  sendAvailable,
  onClose,
  onForward,
}: {
  self: MfPerson;
  targets: MfTarget[];
  sendAvailable: boolean;
  onClose: () => void;
  onForward: (draft: MfDraft, target: MfTarget) => Promise<void>;
}): ReactElement {
  const utils = trpc.useUtils();
  const pushToast = useToast((s) => s.push);
  const list = trpc.mergeForward.list.useQuery(undefined, { refetchOnWindowFocus: false });
  const saveDraft = trpc.mergeForward.save.useMutation({
    onSuccess: () => void utils.mergeForward.list.invalidate(),
  });
  const removeDraft = trpc.mergeForward.remove.useMutation({
    onSuccess: () => void utils.mergeForward.list.invalidate(),
  });

  const [editing, setEditing] = useState<MfDraft | null>(null);

  async function persist(draft: MfDraft): Promise<void> {
    await saveDraft.mutateAsync({
      id: draft.id,
      title: draft.title,
      createdAt: draft.createdAt,
      nodes: draft.nodes,
    });
  }

  async function remove(draft: MfDraft): Promise<void> {
    try {
      await removeDraft.mutateAsync({ id: draft.id });
      pushToast({ tone: 'success', title: '已删除草稿' });
    } catch (error) {
      pushToast({
        tone: 'error',
        title: '删除失败',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const drafts: MfDraft[] = useMemo(
    () => (list.data ?? []).map((draft) => coerceDraft(draft)),
    [list.data],
  );

  return (
    <>
      {/* 编辑时把本层的 onClose 交出去：否则编辑器的 Esc 会连列表一起关掉
          （两个 Modal 都监听 document keydown）。关掉编辑器后会回到列表，再按一次才关列表。 */}
      <Modal
        onClose={editing ? undefined : onClose}
        width={620}
        labelledBy="weq-mf-lib-title"
        className="weq-mf-lib-modal"
      >
        <div className="weq-mf-lib">
          <header className="weq-mf-head">
            <span className="weq-mf-head-avatar weq-mf-head-avatar-plain">
              <Layers size={18} strokeWidth={1.8} />
            </span>
            <div className="weq-mf-head-title">
              <strong id="weq-mf-lib-title">合成聊天记录</strong>
              <span className="weq-mf-head-sub">离线也能拼，存好后下次继续编辑</span>
            </div>
            <button type="button" className="weq-mf-icon-btn" title="关闭" onClick={onClose}>
              <X size={18} />
            </button>
          </header>

          <div className="weq-mf-lib-body">
            <button
              type="button"
              className="weq-mf-lib-new"
              onClick={() => setEditing(createEmptyDraft())}
            >
              <FilePlus2 size={17} />
              <span>
                <strong>新建聊天记录</strong>
                <em>空卡片，自由添加消息</em>
              </span>
            </button>

            {list.isLoading ? (
              <div className="weq-mf-empty">加载中…</div>
            ) : drafts.length === 0 ? (
              <div className="weq-mf-empty">还没有草稿 —— 点上面「新建聊天记录」开始拼。</div>
            ) : (
              <ul className="weq-mf-lib-list">
                {drafts.map((draft) => (
                  <li key={draft.id} className="weq-mf-lib-item">
                    <button
                      type="button"
                      className="weq-mf-lib-item-main"
                      onClick={() => setEditing(draft)}
                    >
                      <span className="weq-mf-lib-item-title">{draft.title || draftTitle(draft.nodes)}</span>
                      <span className="weq-mf-lib-item-meta">
                        {draft.nodes.length} 条 · {formatStamp(draft.updatedAt)}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="weq-mf-lib-item-btn"
                      title="继续编辑"
                      onClick={() => setEditing(draft)}
                    >
                      <Pencil size={15} />
                    </button>
                    <button
                      type="button"
                      className="weq-mf-lib-item-btn danger"
                      title="删除"
                      onClick={() => void remove(draft)}
                    >
                      <Trash2 size={15} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </Modal>

      {editing ? (
        <MergeForwardDialog
          initialDraft={editing}
          self={self}
          senderMode="global"
          targets={targets}
          sendAvailable={sendAvailable}
          onClose={() => setEditing(null)}
          onPersist={persist}
          onForward={onForward}
        />
      ) : null}
    </>
  );
}

function formatStamp(seconds: number): string {
  const secs = Number(seconds);
  if (!Number.isFinite(secs) || secs <= 0) return '';
  const d = new Date(secs * 1000);
  const pad = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
