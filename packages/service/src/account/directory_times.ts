interface TimeRow {
  conversation: string;
  time: number;
  senderUid: string;
  senderUin: string;
}
interface Page {
  items: TimeRow[];
  cursor?: string;
  done: boolean;
}
export interface DirectoryTimes {
  time: number | null;
  mine: number | null;
}

/** 每次请求只推进一页，调用方失活即停止；变化在本轮结束后重读，避免持续消息导致饿死。 */
export class DirectoryTimeReader {
  private cursor?: string;
  private done = false;
  private dirty = false;
  private rows: Record<string, DirectoryTimes> = Object.create(null);
  private pending: Record<string, DirectoryTimes> = Object.create(null);
  private inflight?: Promise<{ rows: Record<string, DirectoryTimes>; done: boolean }>;
  constructor(
    private readonly page: (cursor?: string) => Promise<Page>,
    private readonly selfUid: string,
    private readonly selfUin: string,
  ) {}
  invalidate() {
    this.dirty = true;
  }
  read() {
    if (this.inflight) return this.inflight;
    this.inflight = this.advance().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }
  private async advance() {
    if (this.done && this.dirty) {
      this.done = false;
      this.dirty = false;
      this.cursor = undefined;
      this.pending = Object.create(null);
    }
    if (!this.done) {
      const page = await this.page(this.cursor);
      for (const row of page.items) {
        const item = this.pending[row.conversation] ?? { time: null, mine: null };
        item.time = Math.max(item.time ?? 0, row.time);
        const mine =
          this.selfUid && row.senderUid
            ? row.senderUid === this.selfUid
            : Boolean(this.selfUin && row.senderUin === this.selfUin);
        if (mine) item.mine = Math.max(item.mine ?? 0, row.time);
        this.pending[row.conversation] = item;
      }
      this.cursor = page.cursor;
      this.done = page.done;
      if (this.done) this.rows = this.pending;
    }
    return {
      rows: structuredClone(this.done ? this.rows : { ...this.rows, ...this.pending }),
      done: this.done && !this.dirty,
    };
  }
}
