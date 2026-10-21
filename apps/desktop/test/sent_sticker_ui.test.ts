import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { decodeMessage, encode, PUSH_MSG_BODY, UPLOAD_MSG_INFO } from '@weq/protocol';
import { QqImage } from '../src/renderer/src/components/QqMedia';
import { buildOptimisticRender } from '../src/renderer/src/im-template/template/composerSend';
import { elementsToComposerText } from '../src/renderer/src/im-template/template/draftElements';
import { previewNodes, previewNodesToText } from '../src/renderer/src/lib/conversationPreview';

vi.mock('../src/renderer/src/trpc/client', () => {
  const proxy = (): unknown =>
    new Proxy(() => proxy(), {
      get: (_target, key) =>
        key === 'useQuery' ? () => ({ data: undefined, isLoading: false }) : proxy(),
    });
  return { trpc: proxy(), client: proxy() };
});
afterEach(() => {
  vi.unstubAllGlobals();
});

it.each([0, 1])('发送前后图片／表情类型保持一致，普通 GIF 不误作表情：%s', (subType) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const source = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  const body = elementsToComposerText([
    { kind: 'pic', subType, width: 600, height: 600, localPreviewUrl: source },
  ]);
  const before = buildOptimisticRender({ body, locals: [], superStickers: new Map() })
    .elements[0] as { data: Record<string, unknown> };
  const pbElem = encode(UPLOAD_MSG_INFO, {
    msgInfoBody: [
      {
        index: {
          info: {
            fileName: 'fixture.gif',
            width: 600,
            height: 600,
            type: { type: 1, picFormat: 2000 },
          },
          subType: 0,
        },
      },
    ],
    extBizInfo: {
      pic: {
        bizType: subType,
        textSummary: subType ? '[表情]' : '[图片]',
        bytesPbReserveTroop: { subType },
      },
    },
  });
  const decoded = decodeMessage(
    encode(PUSH_MSG_BODY, {
      contentHead: { msgId: 1, sequence: 1, timestamp: 1 },
      body: {
        richText: { elems: [{ commonElem: { serviceType: 48, businessType: 20, pbElem } }] },
      },
    }),
  ).elements[0]!;
  try {
    for (const data of [before.data, { ...decoded, localPreviewUrl: source }]) {
      act(() => root.render(h(QqImage, { data, sendTimeMs: 1000 })));
      expect(host.querySelector('img')?.style.width).toBe(subType ? '120px' : '200px');
      expect(Boolean(host.querySelector('.qq-media-wrap-emoji'))).toBe(Boolean(subType));
      expect(previewNodesToText(previewNodes({ ...data, kind: 'pic' }))).toBe(
        subType ? '[表情]' : '[图片]',
      );
    }
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
