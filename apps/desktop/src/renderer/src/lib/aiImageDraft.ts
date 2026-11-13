import type { AiImageRef } from '@weq/agentlab';

const marker = /\[\[ai-image:([^\]]+)\]\]/g;
export type AiImageAssetRef = AiImageRef & { path: string };
export function parseAiImageDraft(value: string): { text: string; images: AiImageAssetRef[] } {
  const images: AiImageAssetRef[] = [];
  const text = value.replace(marker, (raw, encoded: string) => {
    try {
      const image: unknown = JSON.parse(decodeURIComponent(encoded));
      if (
        !image ||
        typeof image !== 'object' ||
        !('id' in image) ||
        typeof image.id !== 'string' ||
        !('path' in image) ||
        typeof image.path !== 'string'
      )
        return raw;
      images.push(image as AiImageAssetRef);
      return '';
    } catch {
      return raw;
    }
  });
  return { text, images };
}
export function aiImageDraft(text: string, images: AiImageAssetRef[]): string {
  return (
    text +
    images.map((image) => `[[ai-image:${encodeURIComponent(JSON.stringify(image))}]]`).join('')
  );
}
export function changeAiImageDraftText(value: string, text: string): string {
  return aiImageDraft(text, parseAiImageDraft(value).images);
}
