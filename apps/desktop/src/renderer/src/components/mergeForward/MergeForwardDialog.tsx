/**
 * MergeForwardDialog —— 合并转发的使用场景之一：在聊天里多选消息后「合并转发」。
 *
 * 两步：
 *   1. `edit`     —— 预览 + 编辑（核心组件 {@link MergeForwardComposer}）；
 *   2. `targets`  —— 选择要转发到的会话（多选）。
 *
 * 「转发」按钮只在 QQ 在线且已注入时可点（与输入框的发送键同一条件）；不在线时
 * 只能「保存草稿」——草稿落在 weq 目录，下次继续编辑。
 *
 * 真正的发包（UploadLongMsg）由 {@link onForward} 这一处接缝负责，**本组件不碰
 * protocol**。
 */

import { useMemo, useState, type ReactElement } from 'react';
import { ArrowLeft, ClipboardCopy, Save, Share2, X } from 'lucide-react';
import { Modal } from '../Dialog';
import { useToast } from '../Toast';
import { copyTextToClipboard } from '../../im-template/template/clipboard';
import { MergeForwardComposer } from './MergeForwardComposer';
import { MergeForwardTargets } from './MergeForwardTargets';
import { senderAvatarUrl } from './model';
import type { MfPerson } from './SenderPicker';
import { draftTitle, draftToJson, type MfDraft, type MfTarget } from './model';
import { cn } from '../../im-template/template/classNames';

export function MergeForwardDialog({
  initialDraft,
  self,
  members,
  senderMode,
  targets,
  sendAvailable,
  onClose,
  onPersist,
  onForward,
}: {
  initialDraft: MfDraft;
  self: MfPerson;
  /** 会话模式下的发送人候选人（会话成员）。 */
  members?: MfPerson[];
  senderMode: 'conversation' | 'global';
  /** 可转发到的全部会话。 */
  targets: MfTarget[];
  /** QQ 在线且已注入 —— 决定「转发」能不能点。 */
  sendAvailable: boolean;
  onClose: () => void;
  /** 保存草稿（落到 weq 目录）。 */
  onPersist: (draft: MfDraft) => Promise<void> | void;
  /** 发送接缝：真正的合并转发发包在这里接入（本分支不实现）。 */
  onForward: (draft: MfDraft, target: MfTarget) => Promise<void>;
}): ReactElement {
  const pushToast = useToast((s) => s.push);
  const [draft, setDraft] = useState<MfDraft>(initialDraft);
  const [step, setStep] = useState<'edit' | 'targets'>('edit');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);

  const title = useMemo(() => draft.title || draftTitle(draft.nodes), [draft]);
  const canNext = draft.nodes.length > 0;

  function toggleTarget(id: string): void {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function copyJson(): Promise<void> {
    const ok = await copyTextToClipboard(draftToJson(draft));
    pushToast(
      ok
        ? { tone: 'success', title: '已复制 JSON', message: `${draft.nodes.length} 条预览消息` }
        : { tone: 'error', title: '复制失败', message: '剪贴板不可用' },
    );
  }

  async function persist(): Promise<void> {
    await onPersist(draft);
    pushToast({
      tone: 'success',
      title: '草稿已保存',
      message: '下次可在「合成聊天记录」继续编辑',
    });
  }

  async function forward(): Promise<void> {
    const picked = targets.filter((t) => selected.has(t.id));
    if (picked.length === 0) {
      pushToast({ tone: 'warning', title: '先选择会话' });
      return;
    }
    setSending(true);
    let failed = 0;
    for (const target of picked) {
      try {
        await onForward(draft, target);
      } catch (error) {
        failed += 1;
        pushToast({
          tone: 'error',
          title: `转发到「${target.name}」失败`,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
    setSending(false);
    if (failed > 0) {
      // 协议还没接入 / 发送失败时不要把用户拼好的东西弄丢 —— 存一份草稿。
      await onPersist(draft);
      return;
    }
    pushToast({ tone: 'success', title: '已转发', message: `${picked.length} 个会话` });
    onClose();
  }

  return (
    <Modal onClose={onClose} width={880} labelledBy="weq-mf-title" className="weq-mf-modal">
      <div className="weq-mf">
        <header className="weq-mf-head">
          {step === 'targets' ? (
            <button
              type="button"
              className="weq-mf-icon-btn"
              title="返回编辑"
              onClick={() => setStep('edit')}
            >
              <ArrowLeft size={18} />
            </button>
          ) : (
            <span className="weq-mf-head-avatar">
              {senderAvatarUrl(self.uin) ? (
                <img src={senderAvatarUrl(self.uin) ?? ''} alt="" />
              ) : (
                <span>{self.name.slice(0, 1)}</span>
              )}
            </span>
          )}
          <div className="weq-mf-head-title">
            {step === 'edit' ? (
              <input
                id="weq-mf-title"
                className="weq-mf-title-input"
                value={draft.title}
                placeholder={title}
                onChange={(e) => setDraft((cur) => ({ ...cur, title: e.target.value }))}
                aria-label="聊天记录标题"
              />
            ) : (
              <strong id="weq-mf-title">选择会话（{selected.size}）</strong>
            )}
            <span className="weq-mf-head-sub">
              {step === 'edit'
                ? `${draft.nodes.length} 条预览消息 · 右键可修改`
                : '可多选，确认后一起转发'}
            </span>
          </div>
          <button type="button" className="weq-mf-icon-btn" title="退出" onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        <div className="weq-mf-body">
          {step === 'edit' ? (
            <MergeForwardComposer
              draft={draft}
              onChange={setDraft}
              self={self}
              members={members}
              senderMode={senderMode}
            />
          ) : (
            <MergeForwardTargets targets={targets} selected={selected} onToggle={toggleTarget} />
          )}
        </div>

        <footer className="weq-mf-foot">
          <button type="button" className="weq-mf-soft" onClick={() => void copyJson()}>
            <ClipboardCopy size={15} /> 复制 JSON
          </button>
          <span className="weq-mf-foot-spacer" />
          {step === 'edit' ? (
            <>
              <button type="button" className="weq-mf-soft" onClick={onClose}>
                取消
              </button>
              <button
                type="button"
                className="weq-mf-primary"
                disabled={!canNext}
                title={canNext ? '' : '还没有任何预览消息'}
                onClick={() => setStep('targets')}
              >
                下一步：选择会话
              </button>
            </>
          ) : (
            <>
              <button type="button" className="weq-mf-soft" onClick={() => void persist()}>
                <Save size={15} /> 保存草稿
              </button>
              <button
                type="button"
                className={cn('weq-mf-primary')}
                disabled={!sendAvailable || sending || selected.size === 0}
                title={sendAvailable ? '' : 'QQ 未在线或处于完全离线模式，只能保存草稿'}
                onClick={() => void forward()}
              >
                <Share2 size={15} /> {sending ? '转发中…' : '转发'}
              </button>
            </>
          )}
        </footer>
      </div>
    </Modal>
  );
}
