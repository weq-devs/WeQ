import { useEffect, useRef, useState, type RefObject } from 'react';
import { Search, X } from 'lucide-react';
import { Modal } from '../../components/Dialog';
import { formatChatTime } from './messageTime';
import '../../styles/generated-search.css';

export function jumpToGeneratedMessage(transcript: HTMLElement | null, messageId: string): boolean {
  const target = [
    ...(transcript?.querySelectorAll<HTMLElement>('[data-generated-message-id]') ?? []),
  ].find((node) => node.dataset.generatedMessageId === messageId);
  target?.scrollIntoView({ block: 'center', behavior: 'instant' });
  return Boolean(target);
}

export function CloneSearchButton({
  messages,
  onJump,
}: {
  messages: readonly { id?: string; text: string; ts: number }[];
  onJump: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const keyword = query.trim().toLocaleLowerCase();
  const matches = keyword
    ? messages.filter((item) => item.id && item.text.toLocaleLowerCase().includes(keyword))
    : [];
  return (
    <>
      <button
        type="button"
        className="icon-button group-header-info-action chat-header-search-action"
        title="搜索聊天记录"
        aria-label="搜索聊天记录"
        onClick={() => setOpen(true)}
      >
        <Search size={18} />
      </button>
      {open ? (
        <Modal
          presentation="floating"
          onClose={() => setOpen(false)}
          width={640}
          labelledBy="weq-clone-search-title"
        >
          <div className="weq-clone-records">
            <header>
              <strong id="weq-clone-search-title">搜索聊天记录</strong>
              <button
                className="weq-dialog-x"
                type="button"
                aria-label="关闭"
                onClick={() => setOpen(false)}
              >
                <X size={16} />
              </button>
            </header>
            <input
              aria-label="搜索当前会话"
              placeholder="搜索当前会话"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <div className="weq-clone-record-results">
              {matches.length ? (
                matches.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      onJump(item.id!);
                      setOpen(false);
                    }}
                  >
                    <time>{formatChatTime(item.ts)}</time>
                    <span data-privacy-sensitive>{item.text}</span>
                  </button>
                ))
              ) : (
                <p role="status">{keyword ? '没有匹配的消息' : '搜索当前会话'}</p>
              )}
            </div>
          </div>
        </Modal>
      ) : null}
    </>
  );
}

export function useGeneratedSearchJump(
  transcript: RefObject<HTMLDivElement | null>,
  messageId: string | null,
  ready: boolean,
  messages: readonly unknown[],
) {
  const [missing, setMissing] = useState(false);
  const jumped = useRef<string | null>(null);
  useEffect(() => {
    if (!messageId || !ready || jumped.current === messageId) return;
    const frame = requestAnimationFrame(() => {
      const found = jumpToGeneratedMessage(transcript.current, messageId);
      setMissing(!found);
      if (found) {
        jumped.current = messageId;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [messageId, ready, messages, transcript]);
  return Boolean(messageId && missing);
}

export function GeneratedSearchNotice({ missing, error }: { missing: boolean; error: boolean }) {
  return missing || error ? (
    <div className="weq-generated-search-notice" role="status">
      {error ? '记录加载失败' : '该条记录已不在当前会话中'}
    </div>
  ) : null;
}
