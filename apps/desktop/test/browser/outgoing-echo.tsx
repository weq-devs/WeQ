import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MessageBubble } from '../../src/renderer/src/im-template/template/messageBubble';
import {
  ShowMessageSeqContext,
  ShowMessageTimeContext,
} from '../../src/renderer/src/components/MessageProvenance.shared';
import { createTemplateDemoData } from '../support/templateDemoData';
import '../../src/renderer/src/styles/index.css';

const demo = createTemplateDemoData();
const conversation = demo.conversations.find((row) => row.type === 'direct')!;
function Scene() {
  const [stage, setStage] = useState<'host' | 'qq' | 'failed' | 'acked' | 'confirmed'>('host');
  Object.assign(window, { echoQA: { setStage } });
  return (
    <main
      className="im-template"
      style={{
        padding: 24,
        minHeight: '100dvh',
        background: 'var(--background)',
        color: 'var(--foreground)',
      }}
    >
      <ShowMessageSeqContext.Provider value>
        <ShowMessageTimeContext.Provider value>
          {[
            '不等电脑和装扮，发送后立即显示。',
            '这是一条较长的本地消息。\n装扮资源尚未返回，正文仍然可见。\n传输失败后保留消息及失败标签。',
          ].map((body, index) => (
            <MessageBubble
              key={body}
              message={{
                id: stage === 'confirmed' ? `qq-${index}` : `local-${index}`,
                outgoingId: `local-${index}`,
                conversationId: conversation.id,
                senderId: demo.user.id,
                body,
                createdAt:
                  stage === 'confirmed' ? '2026-10-20T03:00:02Z' : '2026-10-20T03:00:01.500Z',
                msgSeq: stage === 'acked' || stage === 'confirmed' ? String(index + 12) : undefined,
                optimistic:
                  stage === 'confirmed'
                    ? undefined
                    : stage === 'acked'
                      ? 'sent'
                      : stage === 'failed'
                        ? 'failed'
                        : 'sending',
                outgoingToHost: stage === 'host',
                decoration: { bubbleId: 21001, fontId: 32002, widgetId: 10001 },
              }}
              conversation={conversation}
              sender={demo.user}
              mine
              senderName="我"
              onContextMenu={() => {}}
              onLongPress={() => {}}
            />
          ))}
        </ShowMessageTimeContext.Provider>
      </ShowMessageSeqContext.Provider>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Scene />);
