import type { ConversationReadingPosition } from './conversationReadingPosition';

export interface TimelineGeometry {
  id: string;
  top: number;
  bottom: number;
}
export interface TimelineViewport {
  capture?(): ConversationReadingPosition | undefined;
  scrollTo(
    id: string,
    options?: { align?: 'start' | 'center' | 'end'; flash?: boolean; focus?: boolean },
  ): boolean;
  restore(position: ConversationReadingPosition): boolean;
  geometry(): TimelineGeometry[];
  offset(id: string): number | undefined;
  bottom(): void;
}

const viewports = new WeakMap<HTMLElement, TimelineViewport>();
export const timelineViewport = (element: HTMLElement) => viewports.get(element);
export function registerTimelineViewport(element: HTMLElement, viewport: TimelineViewport) {
  viewports.set(element, viewport);
  return () => {
    if (viewports.get(element) === viewport) viewports.delete(element);
  };
}

export function messageElement(scroll: HTMLElement, id: string): HTMLElement | undefined {
  return [...scroll.querySelectorAll<HTMLElement>('[data-message-id]')].find(
    (element) => element.dataset.messageId === id,
  );
}

/** 虚拟化只改变 DOM，不把已加载但未挂载的消息当成不存在。 */
export function revealTimelineMessage(scroll: HTMLElement, id: string, flash = false): boolean {
  const viewport = timelineViewport(scroll);
  if (viewport) return viewport.scrollTo(id, { align: 'center', flash });
  const line = messageElement(scroll, id);
  if (!line) return false;
  line.scrollIntoView({ block: 'center' });
  if (flash) {
    line.classList.add('weq-reply-target-flash');
    setTimeout(() => line.classList.remove('weq-reply-target-flash'), 1600);
  }
  return true;
}
