import { parseFlashShareCode } from '../../lib/flashShare';
import type { MessageContextMenuState } from './messageContextMenu';

export function messageCardElements(
  state: Pick<
    MessageContextMenuState,
    'message' | 'forwardTarget' | 'originElement' | 'mediaTarget'
  >,
) {
  const elements = state.message.qqElements ?? [];
  const forwarded = state.forwardTarget && elements[state.forwardTarget.elementIndex];
  if (forwarded) return [forwarded];
  const structured = elements.find((element) =>
    ['ark', 'wallet', 'qqDynamic', 'shareLocation', 'multiMsg', 'structLongMsg'].includes(
      element.type ?? '',
    ),
  );
  if (structured) return [structured];
  const flash = elements.find((element) => {
    const info = element.data?.flashTransferInfo;
    return (
      (element.type === 'markdown' &&
        info &&
        typeof info === 'object' &&
        Object.keys(info).length) ||
      (element.type === 'text' && parseFlashShareCode(String(element.data?.textContent ?? '')))
    );
  });
  if (flash) return [flash];
  if (elements.some((element) => element.type === 'inlineKeyboard'))
    return elements.filter(
      ({ type }) => type === 'inlineKeyboard' || type === 'markdown' || type === 'mface',
    );
  if (state.originElement?.querySelector('.weq-link-card'))
    return elements.filter(({ type }) => type === 'text');
  const media = state.mediaTarget;
  const attachment =
    media?.kind === 'file'
      ? elements.find(
          ({ type, data }) =>
            type === 'file' &&
            String(data?.fileName ?? '') === media.name &&
            String(data?.fileToken ?? '') === media.token,
        )
      : elements.find(({ type }) => type === 'onlineFile' || type === 'onlineFolder');
  return attachment ? [attachment] : [];
}
