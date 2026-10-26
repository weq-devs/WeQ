import { createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatPane } from '../../src/renderer/src/im-template/template/chatPane';
import { createTemplateDemoData } from '../../src/renderer/src/im-template/template/demoData';
import { qqMessageRenderer } from '../../src/renderer/src/components/QqMessageContent';
import {
  ContentSelectionProvider,
  useContentMultiSelect,
  useContentExportRequest,
} from '../../src/renderer/src/state/contentSelection';
import {
  captureReadingPosition,
  restoreReadingPosition,
} from '../../src/renderer/src/lib/conversationReadingPosition';
import {
  revealTimelineMessage,
  timelineViewport,
} from '../../src/renderer/src/lib/timelineViewport';
import type { Message } from '../../src/renderer/src/im-template/template/types';
import '../../src/renderer/src/styles/index.css';

const demo = createTemplateDemoData();
const avatar =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=';
const image = (() => {
  const canvas = document.createElement('canvas');
  canvas.width = 300;
  canvas.height = 400;
  const drawing = canvas.getContext('2d')!;
  drawing.fillStyle = '#337b69';
  drawing.fillRect(0, 0, 300, 400);
  drawing.fillStyle = '#e8bc58';
  drawing.fillRect(24, 32, 252, 120);
  drawing.fillStyle = '#f0f3ed';
  drawing.fillRect(24, 180, 150, 180);
  return canvas.toDataURL();
})();
const user = { ...demo.user, avatarUrl: avatar };
const conversation = {
  ...demo.conversations.find((row) => row.type === 'direct')!,
  unreadCount: 0,
  id: 'u_synthetic',
  otherUser: { ...demo.user, id: 'u_peer', displayName: '合成联系人', avatarUrl: avatar },
};
const message = (seq: number): Message => ({
  id: `row-${seq}`,
  conversationId: conversation.id,
  senderId: seq % 3 ? 'u_peer' : user.id,
  body: `合成消息 ${seq}：${'用于检查长时间线和动态高度。'.repeat((Math.abs(seq) % 8) + 1)}`,
  createdAt: new Date(1792544400000 + seq * 1000).toISOString(),
  msgSeq: String(seq),
  qqElements:
    seq % 19 === 0
      ? [
          {
            type: 'pic',
            data: {
              fileName: `fixture-${seq}.png`,
              localPreviewUrl: image,
              imgWidth: 300,
              imgHeight: 180 + (seq % 5) * 80,
            },
          },
        ]
      : undefined,
});
const scroll = () => document.querySelector<HTMLElement>('.message-scroll')!;
const bridge: Record<string, unknown> = {};
Object.assign(window, { timelineTest: bridge });

function Fixture() {
  const [messages, setMessages] = useState(() =>
    Array.from({ length: 3000 }, (_, i) => message(i + 1001)),
  );
  const [atLatest, setAtLatest] = useState(true);
  const [active, setActive] = useState(true);
  const [initialPosition, setInitialPosition] = useState(true);
  const selection = useContentMultiSelect({
    kind: 'messages',
    container: `direct:${conversation.id}`,
  });
  const exportRequest = useContentExportRequest();
  Object.assign(bridge, {
    setCount: (count: number) =>
      setMessages(Array.from({ length: count }, (_, i) => message(i + 1001))),
    jump: (id: string) => revealTimelineMessage(scroll(), id, true),
    capture: () => captureReadingPosition(scroll()),
    restore: (position: Parameters<typeof restoreReadingPosition>[1]) =>
      restoreReadingPosition(scroll(), position),
    prepend: () => {
      setAtLatest(false);
      setMessages((rows) => [...Array.from({ length: 50 }, (_, i) => message(951 + i)), ...rows]);
    },
    append: () => setMessages((rows) => [...rows, message(Number(rows.at(-1)!.msgSeq) + 1)]),
    selectAll: () => {
      selection.setSelectionMode(true);
      selection.setSelectedIds(new Set(messages.map((row) => row.id)));
    },
    enterSelection: () => selection.setSelectionMode(true),
    clearSelection: () => {
      selection.setSelectedIds(new Set());
      selection.anchorRef.current = null;
    },
    mixedRows: () =>
      setMessages((rows) =>
        rows
          .filter((row) => ![1081, 1082, 1083, 1084].includes(Number(row.msgSeq)))
          .flatMap((row) =>
            row.id === 'row-1080'
              ? [
                  row,
                  {
                    ...row,
                    id: 'row-1080-tip',
                    qqElements: [
                      {
                        type: 'grayTipXml',
                        data: { grayTipXmlContent: '<gtip><nor txt="合成系统消息"/></gtip>' },
                      },
                    ],
                  },
                ]
              : [row],
          ),
      ),
    selected: () => [...selection.selectedIds],
    exportSelection: () => exportRequest?.selection,
    active: (value: boolean) => setActive(value),
    latestWindow: () => setAtLatest(true),
    dropInitialPosition: () => setInitialPosition(false),
    pinPlayback: (id: string) => {
      const row = scroll().querySelector(`[data-message-id="${id}"]`);
      if (row) {
        const voice = document.createElement('span');
        voice.className = 'qq-media-voice is-playing';
        row.append(voice);
      }
    },
    unpinPlayback: (id: string) =>
      scroll()
        .querySelector(`[data-message-id="${id}"] .qq-media-voice`)
        ?.classList.remove('is-playing'),
    geometry: () => timelineViewport(scroll())?.geometry(),
    grow: (id: string) => {
      const row = scroll().querySelector<HTMLElement>(`[data-message-id="${id}"]`);
      if (row) row.style.minHeight = '650px';
    },
  });
  return createElement(
    'div',
    {
      className: 'weq-readonly-chat',
      style: {
        height: '100dvh',
        display: active ? 'grid' : 'none',
        gridTemplateColumns: 'minmax(0,1fr)',
      },
    },
    createElement(ChatPane, {
      user,
      conversation,
      messages,
      messageRenderers: [qqMessageRenderer],
      atLatest,
      loading: false,
      draft: '',
      tabActive: active,
      initialReadingPosition: initialPosition ? { scrollTop: 0 } : undefined,
      onSend: async () => {},
      onDraftChange() {},
      onDraftClear() {},
      onBack() {},
    }),
  );
}
createRoot(document.getElementById('root')!).render(
  createElement(ContentSelectionProvider, null, createElement(Fixture)),
);
