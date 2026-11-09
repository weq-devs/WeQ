export const PREVIEW_MAX_SIDE = 512;

export type ImageRequest =
  | { operation: 'metadata'; input: Uint8Array | string; maxPixels: number }
  | { operation: 'preview'; input: Uint8Array; maxPixels: number; preserveAnimation: boolean };

export interface ImageMetadata {
  width?: number;
  height?: number;
  pageHeight?: number;
  pages?: number;
}

export type ImageResult = Buffer | ImageMetadata;
export type ImageReply = { id: number } & ({ result: ImageResult } | { error: string });
