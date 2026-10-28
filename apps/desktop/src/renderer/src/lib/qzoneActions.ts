export function qzoneForwardDraft(quotePrevious: boolean, content: string): string {
  return quotePrevious && content.trim() ? `//：${content}` : '';
}

/** 自动补齐只消费本轮额度，只有向下滚动才能开启下一轮。 */
export class QzoneRelatedRound {
  private used = 0;
  readonly limit = 5;

  take(): boolean {
    if (this.used >= this.limit) return false;
    this.used++;
    return true;
  }

  get exhausted(): boolean {
    return this.used >= this.limit;
  }

  scrollDown(): boolean {
    if (!this.exhausted) return false;
    this.used = 0;
    return true;
  }
}
