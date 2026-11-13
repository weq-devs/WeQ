import { useEffect, useRef, useState } from 'react';
import { LocateFixed, RotateCw, X } from 'lucide-react';
import { client } from '../trpc/client';
import { formatFileTime } from '../lib/groupFile';
import '../styles/group-file-message-results.css';

type Page = Awaited<ReturnType<typeof client.account.findGroupFileMessages.query>>;
interface Props {
  groupCode: string;
  fileId: string;
  fileName: string;
  binding: { expectedAccountUin: string; expectedAccountConfigId: string };
  onJump: (sequence: string, messageId: string) => void;
  onClose: () => void;
}

export function GroupFileMessageResults({
  groupCode,
  fileId,
  fileName,
  binding,
  onJump,
  onClose,
}: Props) {
  const [page, setPage] = useState<Page>({ messages: [], nextBefore: null });
  const [pending, setPending] = useState(true);
  const [error, setError] = useState('');
  const [request, setRequest] = useState<{ before?: NonNullable<Page['nextBefore']>; id: number }>({
    id: 0,
  });
  const jump = useRef(onJump);
  jump.current = onJump;
  const { expectedAccountUin, expectedAccountConfigId } = binding;
  useEffect(() => {
    let active = true;
    setPending(true);
    setError('');
    void client.account.findGroupFileMessages
      .query({
        groupCode,
        fileId,
        expectedAccountUin,
        expectedAccountConfigId,
        before: request.before,
      })
      .then((result) => {
        if (!active) return;
        setPage((old) => ({
          messages: request.before ? [...old.messages, ...result.messages] : result.messages,
          nextBefore: result.nextBefore,
        }));
        setPending(false);
        if (!request.before && !result.nextBefore && result.messages.length === 1) {
          const message = result.messages[0]!;
          jump.current(message.msgSeq, message.msgId);
        }
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setError(reason instanceof Error ? reason.message : '查询原消息失败');
        setPending(false);
      });
    return () => {
      active = false;
    };
  }, [groupCode, fileId, expectedAccountUin, expectedAccountConfigId, request]);

  return (
    <section className="weq-file-message-results" aria-label="群文件原消息" aria-busy={pending}>
      <header>
        <strong>原消息 · {fileName}</strong>
        <button
          type="button"
          className="icon-button"
          title="关闭定位结果"
          aria-label="关闭定位结果"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </header>
      {pending && <p role="status">正在查找原消息…</p>}
      {error && <p role="alert">{error}</p>}
      {!pending && !error && !page.messages.length && !page.nextBefore && (
        <p role="status">本地未找到对应消息</p>
      )}
      <ul>
        {page.messages.map((message) => (
          <li key={message.msgId}>
            <button
              type="button"
              onClick={() => onJump(message.msgSeq, message.msgId)}
              title="定位原消息"
            >
              <LocateFixed size={16} />
              <span>
                {formatFileTime(Number(message.sendTime)) || '发送时间未知'} · 消息 {message.msgSeq}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {error ? (
        <button
          type="button"
          className="icon-button"
          title="重试定位"
          aria-label="重试定位"
          onClick={() => setRequest((old) => ({ ...old, id: old.id + 1 }))}
        >
          <RotateCw size={16} />
        </button>
      ) : page.nextBefore ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => setRequest((old) => ({ before: page.nextBefore!, id: old.id + 1 }))}
        >
          查找更早记录
        </button>
      ) : null}
    </section>
  );
}
