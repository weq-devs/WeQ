import { useLayoutEffect, useMemo, useRef } from 'react';
import type { GroupCallChatMessage } from '@weq/service';
import { trpc } from '../../trpc/client';
import { FaceEmoji } from '../FaceEmoji';
import { QqAvatar } from '../QqAvatar';
import { groupCallFaces, splitGroupCallChat } from './groupCallChat';

export function GroupCallChatPanel({
  messages,
  name,
}: {
  messages: readonly GroupCallChatMessage[];
  name: (uin: number) => string;
}) {
  const systemFaces = trpc.account.getSystemFaces.useQuery(undefined, { staleTime: Infinity });
  const faces = useMemo(() => groupCallFaces(systemFaces.data ?? []), [systemFaces.data]);
  const log = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const lastMessage = messages.at(-1)?.id;

  useLayoutEffect(() => {
    if (lastMessage && log.current && follow.current)
      log.current.scrollTop = log.current.scrollHeight;
  }, [lastMessage, faces]);

  return (
    <>
      <div className="weq-group-call-rail-heading">
        <strong>通话消息</strong>
      </div>
      <div
        ref={log}
        className="weq-group-call-chat"
        role="log"
        aria-label="通话消息"
        tabIndex={0}
        onScroll={(event) => {
          const { scrollHeight, scrollTop, clientHeight } = event.currentTarget;
          follow.current = scrollHeight - scrollTop - clientHeight < 24;
        }}
      >
        {messages.length ? (
          <ul>
            {messages.map((message) => (
              <li key={message.id}>
                <QqAvatar uin={String(message.senderUin)} size={30} />
                <div className="weq-group-call-chat-entry">
                  <span className="weq-group-call-chat-sender" title={name(message.senderUin)}>
                    {name(message.senderUin)}
                  </span>
                  <div className="weq-group-call-chat-text">
                    {splitGroupCallChat(message.text, faces).map((part) =>
                      part.faceId === undefined ? (
                        <span key={part.offset}>{part.text}</span>
                      ) : (
                        <FaceEmoji
                          key={part.offset}
                          element={{ faceId: part.faceId, faceText: part.text }}
                          fallbackText={part.text}
                          size="1.3em"
                        />
                      ),
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="weq-group-call-chat-empty">还没有通话消息</p>
        )}
      </div>
    </>
  );
}
