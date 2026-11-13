import type { MessageBubbleSkin } from '@weq/service';
import { decorationImageCache } from './decodedImageCache';

const skins = new Map<number, MessageBubbleSkin>();
const MAX_SKINS = 512;

/** 收到消息页/预取页时启动预热，不 await，也不延后消息的发布。 */
export function seedMessageBubbles(incoming?: readonly MessageBubbleSkin[]): void {
  for (const skin of incoming ?? []) {
    skins.delete(skin.itemId);
    skins.set(skin.itemId, skin);
    if (skin.baseImage) void decorationImageCache.preload(skin.baseImage);
  }
  while (skins.size > MAX_SKINS) skins.delete(skins.keys().next().value!);
}

export function messageBubble(itemId: number): MessageBubbleSkin | undefined {
  return skins.get(itemId);
}
