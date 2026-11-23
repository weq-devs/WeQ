export const MESSAGE_IMAGE_WINDOW_PREFIX = 'weq-message-image-';
export const MESSAGE_IMAGE_CHANNEL = 'capture:message-image';

export type MessageImageAction = 'prepare' | 'append' | 'finish';
export type MessageImageResult = { ok: true } | { ok: false; error: string };
