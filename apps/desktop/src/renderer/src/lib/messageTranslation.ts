import type { Message } from '../im-template/template/types';
import { textMarkdownBody } from '../state/textMarkdown';
import { parseFlashShareCode } from './flashShare';
import { soleLink } from './linkify';

export function messageTranslationText(message: Message): string | null {
  if (message.flashPhotoPlaceholder) return null;
  const elements = message.qqElements?.filter(
    ({ type }) => type !== 'reply' && type !== 'at' && type !== 'face',
  );
  const text = (elements ? textMarkdownBody(elements) : message.body)?.trim();
  if (!text || text.length > 4096 || !/\b[A-Za-z]{2,}\b/.test(text)) return null;
  return parseFlashShareCode(text) || soleLink(text) ? null : text;
}
