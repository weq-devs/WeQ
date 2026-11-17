import { createRoot } from 'react-dom/client';
import { ConvContext, ReplyJumpContext } from '../../src/renderer/src/state/messageContext';
import { QqMessageContent } from '../../src/renderer/src/components/QqMessageContent';
import { MediaPreviewHost } from '../../src/renderer/src/components/mediaPreviewStore';
import { useDataSaver } from '../../src/renderer/src/lib/dataSaver';
import { useThemeStore, type ThemePreference } from '../../src/renderer/src/state/theme';
import '../../src/renderer/src/styles/index.css';

declare global {
  interface Window {
    replyImages: {
      jumps: unknown[];
      setDataSaver: (enabled: boolean) => void;
      setTheme: (theme: ThemePreference, accent: string) => void;
    };
  }
}

window.replyImages = {
  jumps: [],
  setDataSaver: (enabled) => useDataSaver.setState({ enabled }),
  setTheme(theme, accent) {
    useThemeStore.getState().setAccent(accent);
    useThemeStore.getState().setPreference(theme);
  },
};
useDataSaver.setState({ enabled: true });

const pictures: Record<string, Record<string, unknown>> = {
  loaded: { localPreviewUrl: '/test/reply-image.png', fileName: 'loaded.png' },
  deferred: { fileName: 'deferred.png' },
  failed: { fileName: 'retry.png' },
  flash: { fileToken: '/10001-2-ABC', isFlash: true },
};

createRoot(document.getElementById('root')!).render(
  <ConvContext.Provider value="12345">
    <ReplyJumpContext.Provider value={(target) => window.replyImages.jumps.push(target)}>
      <main className="reply-images-fixture">
        <style>{`
          body{margin:0;background:var(--weq-chat-bg);color:var(--weq-fg-primary)}
          .reply-images-fixture{padding:24px;max-width:600px}
          .reply-images-fixture article{margin-bottom:24px}
          .reply-images-fixture .message-bubble{width:fit-content;max-width:100%}
        `}</style>
        {Object.entries(pictures).map(([id, data]) => (
          <article key={id} data-reply-image={id}>
            <div className="message-bubble">
              <QqMessageContent
                sendTimeMs={1700000010000}
                msgId={id}
                elements={[
                  {
                    type: 'reply',
                    data: {
                      origMsgSeq: 42,
                      origMsgTime: 1700000000,
                      origSenderDisplayName: '合成成员',
                      origElements: [
                        { type: 'pic', data: { imgWidth: 400, imgHeight: 300, ...data } },
                        { type: 'text', data: { textContent: '引用图文说明' } },
                      ],
                    },
                  },
                  { type: 'text', data: { textContent: '合成回复正文' } },
                ]}
              />
            </div>
          </article>
        ))}
      </main>
      <MediaPreviewHost />
    </ReplyJumpContext.Provider>
  </ConvContext.Provider>,
);
