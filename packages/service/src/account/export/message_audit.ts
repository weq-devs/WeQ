import type { RenderElement } from '../msg_view';

export interface MessageCoverage {
  messages: number;
  unknownMessages: number;
  unknownElements: number;
  emptyMessages: number;
  unresolvedForwards?: number;
}

export class MessageAudit {
  readonly coverage: MessageCoverage = {
    messages: 0,
    unknownMessages: 0,
    unknownElements: 0,
    emptyMessages: 0,
  };
  observe(elements: readonly RenderElement[]): void {
    this.coverage.messages++;
    if (!elements.length) this.coverage.emptyMessages++;
    let unknown = 0;
    const visit = (value: unknown, depth: number) => {
      if (depth > 16 || !value || typeof value !== 'object') return;
      if (Array.isArray(value)) {
        for (const item of value) visit(item, depth + 1);
        return;
      }
      const item = value as Record<string, unknown>;
      if (item.type === 'unknown' || item.kind === 'unknown') unknown++;
      if (item.type === 'multiMsg') {
        const data = item.data as { forwardMessages?: unknown[] } | undefined;
        if (!data?.forwardMessages?.length)
          this.coverage.unresolvedForwards = (this.coverage.unresolvedForwards ?? 0) + 1;
      }
      // Follow only structured message content, never arbitrary raw fields/blobs.
      for (const key of ['elements', 'messages', 'data', 'forwardMessages', 'origElements'])
        if (item[key]) visit(item[key], depth + 1);
    };
    visit(elements, 0);
    this.coverage.unknownElements += unknown;
    if (unknown) this.coverage.unknownMessages++;
  }
}
