import { useEffect, useRef, useState } from 'react';
import {
  Bold,
  Check,
  ChevronDown,
  Italic,
  Link,
  List,
  ListOrdered,
  LoaderCircle,
  Paperclip,
  Quote,
  Save,
  Send,
  Underline,
  X,
} from 'lucide-react';
import type { MailComposeInput } from '@weq/service/mail';
import { useDialog } from '../../components/Dialog';
import { useToast } from '../../components/Toast';
import { IS_WEB } from '../../lib/target';
import { registerMailDraft } from '../../state/mailDraft';
import type { MailApi } from './api';
import {
  formatMailSize,
  mailError,
  mailExternalLink,
  parseMailRecipients,
  plainMailText,
  sanitizeMailEditorHtml,
  textMailHtml,
  type MailDraft,
} from './content';

function snapshot(draft: MailDraft): string {
  return JSON.stringify([
    draft.to,
    draft.cc,
    draft.bcc,
    draft.subject,
    draft.content,
    draft.plainText,
    draft.attachments.map((item) => item.id),
  ]);
}

export function MailComposer({
  initial,
  api,
  ready,
  hidden,
  onClose,
  onSubmitted,
  onInspect,
  onBusyChange,
  onDirtyChange,
}: {
  initial: MailDraft;
  api: MailApi;
  ready: boolean;
  hidden: boolean;
  onClose(): void;
  onSubmitted(id: string): void;
  onInspect(folderId: number): void;
  onBusyChange(busy: boolean): void;
  onDirtyChange(dirty: boolean): void;
}) {
  const [draft, setDraft] = useState(initial);
  const [saved, setSaved] = useState(initial.draftId ? snapshot(initial) : '');
  const [more, setMore] = useState(Boolean(initial.cc || initial.bcc));
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const [uncertainDraft, setUncertainDraft] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false),
    [link, setLink] = useState('');
  const editor = useRef<HTMLDivElement>(null);
  const range = useRef<Range | null>(null);
  const active = useRef(true),
    lock = useRef(false),
    upload = useRef<AbortController | null>(null);
  const draftOwner = useRef(Symbol('mail-draft'));
  const meaningful = Boolean(
    draft.to.trim() ||
      draft.cc.trim() ||
      draft.bcc.trim() ||
      draft.subject.trim() ||
      plainMailText(draft.content).trim() ||
      draft.attachments.length,
  );
  const dirty = meaningful && saved !== snapshot(draft);
  useEffect(
    () => registerMailDraft(draftOwner.current, { dirty, busy: busy || uploading }),
    [dirty, busy, uploading],
  );
  function update(patch: Partial<MailDraft>): void {
    setDraft((current) => ({ ...current, ...patch }));
  }

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      upload.current?.abort();
    };
  }, []);
  useEffect(() => {
    onBusyChange(busy || uploading);
    return () => onBusyChange(false);
  }, [busy, uploading, onBusyChange]);
  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (editor.current && !draft.plainText) {
      const safe = sanitizeMailEditorHtml(draft.content);
      if (editor.current.innerHTML !== safe) editor.current.innerHTML = safe;
    }
  }, [draft.plainText, draft.content]);
  useEffect(() => {
    if (!dirty || !IS_WEB) return;
    const beforeUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [dirty]);

  async function close(): Promise<void> {
    if (busy || uploading) return;
    if (
      dirty &&
      !(await useDialog.getState().confirm('放弃未保存的邮件？', '当前内容尚未保存到草稿箱。', {
        okLabel: '放弃',
        cancelLabel: '继续编辑',
        tone: 'warning',
      }))
    )
      return;
    onClose();
  }

  function format(command: string, value?: string): void {
    const element = editor.current;
    if (!element || busy) return;
    element.focus();
    document.execCommand('styleWithCSS', false, 'false');
    document.execCommand(command, false, value);
    update({ content: element.innerHTML });
  }

  async function chooseFile(): Promise<void> {
    if (uploading || busy) return;
    const controller = new AbortController();
    upload.current = controller;
    setUploading(true);
    setError('');
    try {
      const result = await api.upload(controller.signal);
      if (active.current && !controller.signal.aborted && result)
        setDraft((current) => ({ ...current, attachments: [...current.attachments, result] }));
    } catch (error) {
      if (active.current && !controller.signal.aborted) setError(mailError(error));
    } finally {
      if (active.current) setUploading(false);
      if (upload.current === controller) upload.current = null;
    }
  }

  async function submit(saveDraft: boolean): Promise<void> {
    if (lock.current || uploading || uncertain || !ready) return;
    let message: MailComposeInput;
    try {
      const to = parseMailRecipients(draft.to),
        cc = parseMailRecipients(draft.cc),
        bcc = parseMailRecipients(draft.bcc);
      if (to.length + cc.length + bcc.length > 100)
        throw new Error('单封邮件最多填写 100 个收件人。');
      if (draft.content.length > 2_000_000) throw new Error('邮件正文超过大小上限。');
      if (!saveDraft && to.length + cc.length + bcc.length === 0) throw new Error('请填写收件人。');
      message = {
        to,
        cc,
        bcc,
        subject: draft.subject,
        content: draft.plainText ? draft.content : sanitizeMailEditorHtml(draft.content),
        plainText: draft.plainText,
        attachments: draft.attachments.map((item) => item.id),
        replyId: draft.replyId,
        forwardId: draft.forwardId,
        draftId: draft.draftId,
      };
    } catch (error) {
      setError(mailError(error));
      return;
    }
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await api.send(message, saveDraft);
      if (!active.current) return;
      if (result.state === 'accepted') {
        if (saveDraft) {
          update({ draftId: result.id || draft.draftId });
          setSaved(snapshot(draft));
        } else {
          useToast.getState().push({ tone: 'success', title: '邮件已提交发送' });
          onSubmitted(result.id);
        }
      } else {
        setError(result.message);
        setUncertain(result.state === 'unknown');
        setUncertainDraft(saveDraft);
      }
    } catch {
      if (active.current) {
        setUncertain(true);
        setUncertainDraft(saveDraft);
        setError(
          saveDraft
            ? '保存结果未知，请先检查草稿箱，不要直接重试。'
            : '发送结果未知，请先检查已发送，不要直接重发。',
        );
      }
    } finally {
      lock.current = false;
      if (active.current) setBusy(false);
    }
  }

  return (
    <section className="weq-mail-composer" hidden={hidden} aria-label="写邮件">
      <header className="weq-mail-pane-heading">
        <h2>
          {draft.draftId
            ? '编辑草稿'
            : draft.replyId
              ? '回复邮件'
              : draft.forwardId
                ? '转发邮件'
                : '写邮件'}
        </h2>
        <button
          type="button"
          title="关闭写信"
          aria-label="关闭写信"
          disabled={busy || uploading}
          onClick={() => void close()}
        >
          <X size={18} />
        </button>
      </header>
      <div className="weq-mail-address-fields">
        <label>
          <span>收件人</span>
          <input
            aria-label="收件人邮箱"
            autoComplete="off"
            inputMode="email"
            value={draft.to}
            disabled={busy}
            onChange={(event) => update({ to: event.target.value })}
          />
        </label>
        <button
          type="button"
          className="weq-mail-more-addresses"
          disabled={busy}
          aria-expanded={more}
          onClick={() => setMore((value) => !value)}
        >
          <ChevronDown size={14} />
          抄送 / 密送
        </button>
        {more ? (
          <>
            <label>
              <span>抄送</span>
              <input
                aria-label="抄送邮箱"
                inputMode="email"
                value={draft.cc}
                disabled={busy}
                onChange={(event) => update({ cc: event.target.value })}
              />
            </label>
            <label>
              <span>密送</span>
              <input
                aria-label="密送邮箱"
                inputMode="email"
                value={draft.bcc}
                disabled={busy}
                onChange={(event) => update({ bcc: event.target.value })}
              />
            </label>
          </>
        ) : null}
        <label>
          <span>主题</span>
          <input
            aria-label="邮件主题"
            value={draft.subject}
            maxLength={1000}
            disabled={busy}
            onChange={(event) => update({ subject: event.target.value })}
          />
        </label>
      </div>
      <div className="weq-mail-formatbar">
        {!draft.plainText ? (
          <div className="weq-mail-format-buttons">
            {(
              [
                { icon: Bold, command: 'bold', label: '加粗' },
                { icon: Italic, command: 'italic', label: '斜体' },
                { icon: Underline, command: 'underline', label: '下划线' },
                { icon: List, command: 'insertUnorderedList', label: '项目列表' },
                { icon: ListOrdered, command: 'insertOrderedList', label: '编号列表' },
                { icon: Quote, command: 'formatBlock', value: 'blockquote', label: '引用' },
              ] as const
            ).map((item) => (
              <button
                type="button"
                key={item.command}
                title={item.label}
                aria-label={item.label}
                disabled={busy}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => format(item.command, 'value' in item ? item.value : undefined)}
              >
                <item.icon size={16} />
              </button>
            ))}
            <button
              type="button"
              title="插入链接"
              aria-label="插入链接"
              disabled={busy}
              onMouseDown={(event) => {
                event.preventDefault();
                const selection = window.getSelection();
                range.current =
                  selection?.rangeCount && editor.current?.contains(selection.anchorNode)
                    ? selection.getRangeAt(0).cloneRange()
                    : null;
              }}
              onClick={() => setLinkOpen((value) => !value)}
            >
              <Link size={16} />
            </button>
          </div>
        ) : (
          <span />
        )}
        <fieldset className="weq-mail-mode">
          <legend className="weq-mail-sr-only">正文格式</legend>
          {[false, true].map((plain) => (
            <label key={String(plain)}>
              <input
                type="radio"
                name={`mail-mode-${initial.key}`}
                checked={draft.plainText === plain}
                disabled={busy}
                onChange={() => {
                  setLinkOpen(false);
                  update({
                    plainText: plain,
                    content: plain ? plainMailText(draft.content) : textMailHtml(draft.content),
                  });
                }}
              />
              {plain ? '纯文本' : '富文本'}
            </label>
          ))}
        </fieldset>
      </div>
      {linkOpen ? (
        <div className="weq-mail-link-form">
          <input
            type="url"
            aria-label="链接地址"
            placeholder="https://"
            value={link}
            onChange={(event) => setLink(event.target.value)}
          />
          <button
            type="button"
            title="插入"
            aria-label="插入链接地址"
            onClick={() => {
              const url = mailExternalLink(link);
              if (!url) {
                setError('请填写有效的 HTTP 或 HTTPS 链接。');
                return;
              }
              editor.current?.focus();
              const selection = window.getSelection();
              if (range.current && selection) {
                selection.removeAllRanges();
                selection.addRange(range.current);
              }
              format('createLink', url);
              setLinkOpen(false);
              setLink('');
            }}
          >
            <Check size={16} />
          </button>
          <button
            type="button"
            title="取消"
            aria-label="取消插入链接"
            onClick={() => setLinkOpen(false)}
          >
            <X size={16} />
          </button>
        </div>
      ) : null}
      {draft.plainText ? (
        <textarea
          className="weq-mail-text-editor"
          aria-label="邮件正文编辑器"
          value={draft.content}
          disabled={busy}
          onChange={(event) => update({ content: event.target.value })}
        />
      ) : (
        <div
          ref={editor}
          className="weq-mail-rich-editor"
          role="textbox"
          aria-label="邮件正文编辑器"
          aria-multiline="true"
          contentEditable={!busy}
          suppressContentEditableWarning
          onInput={(event) => update({ content: event.currentTarget.innerHTML })}
          onPaste={(event) => {
            event.preventDefault();
            const html = event.clipboardData.getData('text/html');
            format(
              'insertHTML',
              html
                ? sanitizeMailEditorHtml(html)
                : textMailHtml(event.clipboardData.getData('text/plain')),
            );
          }}
          onDrop={(event) => event.preventDefault()}
          onClick={(event) => {
            if ((event.target as Element).closest?.('a')) event.preventDefault();
          }}
        />
      )}
      {draft.attachments.length || uploading ? (
        <div className="weq-mail-compose-files">
          {draft.attachments.map((item) => (
            <div className="weq-mail-file" key={item.id}>
              <Paperclip size={15} />
              <span title={item.name}>{item.name}</span>
              <small>{formatMailSize(item.size)}</small>
              <button
                type="button"
                disabled={busy}
                title="移除附件"
                aria-label={`移除附件 ${item.name}`}
                onClick={() =>
                  update({
                    attachments: draft.attachments.filter((candidate) => candidate.id !== item.id),
                  })
                }
              >
                <X size={14} />
              </button>
            </div>
          ))}
          {uploading ? (
            <div className="weq-mail-uploading">
              <LoaderCircle size={15} className="weq-mail-spin" />
              <span>正在上传附件</span>
              <button type="button" onClick={() => upload.current?.abort()}>
                取消
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <div role="alert" className="weq-mail-error">
          {error}
          {uncertain ? (
            <div className="weq-mail-reconcile">
              <button type="button" onClick={() => onInspect(uncertainDraft ? 4 : 3)}>
                {uncertainDraft ? '检查草稿箱' : '检查已发送'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setUncertain(false);
                  setError('');
                }}
              >
                已核对，恢复编辑
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      <footer className="weq-mail-compose-footer">
        <button
          type="button"
          title="添加附件"
          aria-label="添加附件"
          disabled={busy || uploading || !ready || draft.attachments.length >= 100}
          onClick={() => void chooseFile()}
        >
          <Paperclip size={17} />
        </button>
        <span className="weq-mail-compose-state">
          {dirty ? '未保存' : draft.draftId ? '草稿已保存' : ''}
        </span>
        <button
          type="button"
          disabled={busy || uploading || uncertain || !ready}
          onClick={() => void submit(true)}
        >
          <Save size={16} />
          保存草稿
        </button>
        <button
          type="button"
          className="weq-mail-primary"
          disabled={busy || uploading || uncertain || !ready}
          onClick={() => void submit(false)}
        >
          {busy ? <LoaderCircle size={16} className="weq-mail-spin" /> : <Send size={16} />}发送
        </button>
      </footer>
    </section>
  );
}
