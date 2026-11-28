import type { ExportMessageSource } from '@weq/service';
import type { ReactNode } from 'react';
import type { MediaSaveSource } from '../../../shared/media_save';

export interface PreviewOcrContext {
  peerType: 'c2c' | 'group';
  fileToken: string;
  width: number;
  height: number;
  md5?: string;
  fileSize?: number;
  expiresAt?: number;
}

export interface PreviewMedia {
  key: string;
  kind: 'image' | 'video';
  src: string;
  poster?: string;
  title?: string;
  isLivePhoto?: boolean;
  fallbackSources?: string[];
  originalImage?: { localSrc?: string; cachedSrc: string; src: string; bytes?: number };
  load?: (refresh?: boolean) => Promise<{ src: string; kind: 'image' | 'video' }>;
  saveSource?: MediaSaveSource | null;
  saveLabel?: string;
  progressTarget?: string;
  messageSource?: ExportMessageSource;
  ocr?: PreviewOcrContext | null;
  order?: { time: number; messageId: string; rawId?: string; element: number; sequence?: string };
}

export interface PreviewPage {
  items: PreviewMedia[];
  hasMore: boolean;
}

export interface MediaPreviewOptions {
  items: PreviewMedia[];
  initialKey?: string;
  initialIndex?: number;
  ownerDocument?: Document;
  label?: string;
  active?: boolean;
  onClose: () => void;
  renderToolbarActions?: (item: PreviewMedia) => ReactNode;
  renderActions?: (item: PreviewMedia) => ReactNode;
  livePhotoToggle?: boolean;
  loadPage?: (direction: 'older' | 'newer') => Promise<PreviewPage>;
  prefetchAdjacent?: boolean;
  hasOlder?: boolean;
  hasNewer?: boolean;
}
