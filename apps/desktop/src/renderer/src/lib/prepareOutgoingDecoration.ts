import type { ResolvedMsgDecoration } from '@weq/service';
import { fontFaces } from './fontFaces';
import { injectBubbleCss, injectFontCss, messageFontFamily } from './msgDecorationStyle';
import { dressFontUrl } from './resourceUrl';

type DecorationIds = { bubbleId: number; fontId: number; widgetId: number };

/** 首次插入发送消息前准备资源，并持有到真实记录接手，避免默认字体闪现。 */
export async function prepareOutgoingDecoration(
  ids: DecorationIds,
  resolve: (ids: DecorationIds) => Promise<ResolvedMsgDecoration>,
): Promise<() => void> {
  const releases: (() => void)[] = [];
  const release = () => {
    for (const dispose of releases.splice(0)) dispose();
  };
  try {
    const [bubble, font] = await Promise.all([
      ids.bubbleId
        ? resolve({ bubbleId: ids.bubbleId, fontId: 0, widgetId: 0 }).then(
            (result) => result.bubble,
          )
        : null,
      ids.fontId
        ? resolve({ bubbleId: 0, fontId: ids.fontId, widgetId: 0 }).then((result) => result.font)
        : null,
    ]);
    if (bubble) releases.push(injectBubbleCss(bubble));
    if (font) {
      const face = fontFaces.acquire(
        messageFontFamily(ids.fontId, font.deriveVersion ?? 0),
        dressFontUrl(ids.fontId, font.deriveVersion ?? 0),
      );
      releases.push(() => face.release());
      await face.ready;
      releases.push(injectFontCss(ids.fontId, font));
    }
    return release;
  } catch (error) {
    release();
    throw error;
  }
}
