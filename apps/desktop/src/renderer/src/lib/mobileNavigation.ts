export type MobileBackEntry = {
  id: string;
  priority: number;
  back: () => void;
  target?: () => HTMLElement | null;
  retained?: boolean;
};

/** 页面只登记现有的返回操作；不保存业务数据，也不重建页面。 */
export class MobileBackStack {
  private entries: MobileBackEntry[] = [];

  get top(): MobileBackEntry | undefined {
    return this.entries.reduce<MobileBackEntry | undefined>(
      (top, entry) => (!top || entry.priority >= top.priority ? entry : top),
      undefined,
    );
  }

  get size(): number {
    return this.entries.length;
  }

  register(entry: MobileBackEntry) {
    this.remove(entry.id);
    this.entries.push(entry);
    return () => this.remove(entry.id);
  }

  remove(id: string) {
    this.entries = this.entries.filter((entry) => entry.id !== id);
  }

  clear() {
    this.entries = [];
  }

  back(): boolean {
    const entry = this.top;
    if (!entry) return false;
    if (!entry.retained) this.remove(entry.id);
    entry.back();
    return true;
  }
}

export function shouldCompleteMobileSwipe(distance: number, elapsed: number, width: number) {
  return (
    distance >= Math.min(width * 0.3, 120) ||
    (distance >= 40 && distance / Math.max(elapsed, 1) > 0.5)
  );
}
