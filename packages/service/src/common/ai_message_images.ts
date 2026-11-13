import type { AiImageRef, AiImageOutcome } from '@weq/agentlab';

export function trainingImageText(text: string, outcomes: AiImageOutcome[]): string {
  return [
    text,
    ...outcomes.map((outcome) =>
      outcome.status === 'read' && outcome.text ? `[图片内容]${outcome.text}` : '[图片]',
    ),
  ]
    .filter(Boolean)
    .join('\n');
}

/** 从已选消息提取图片引用；不读取图片、不扩大消息扫描范围。 */
export function messageImageRefs(
  elements: readonly {
    kind: string;
    fileName?: unknown;
    fileToken?: unknown;
    imgWidth?: unknown;
    imgHeight?: unknown;
    md5?: unknown;
    originalUrl?: unknown;
    subType?: unknown;
    emojiPackId?: unknown;
    marketEmoticonId?: unknown;
    marketEmoticonIdHex?: unknown;
  }[],
  kind: 'c2c' | 'group',
  conv: string,
  msgId: string,
  sendTime: number,
): AiImageRef[] {
  let picIndex = 0;
  return elements
    .filter((element) => element.kind === 'pic' || element.kind === 'mface')
    .map((element, index): AiImageRef => {
      if (element.kind === 'mface') {
        const hash =
          element.marketEmoticonId instanceof Uint8Array
            ? Buffer.from(element.marketEmoticonId).toString('hex')
            : String(element.marketEmoticonIdHex ?? '');
        return {
          id: `${msgId}:${index}`,
          market: { pack: String(element.emojiPackId ?? ''), hash },
        };
      }
      return {
        id: `${msgId}:${index}`,
        chat: { kind, conv, msgId, index: picIndex++ },
        media: {
          fileName: String(element.fileName ?? ''),
          fileToken: String(element.fileToken ?? ''),
          width: Number(element.imgWidth ?? 0),
          height: Number(element.imgHeight ?? 0),
          sendTime,
          md5: String(element.md5 ?? ''),
          originalUrl: String(element.originalUrl ?? ''),
          emoji: Number(element.subType) === 1,
        },
      };
    });
}
