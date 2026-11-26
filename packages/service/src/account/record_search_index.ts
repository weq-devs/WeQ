interface IndexedText {
  body: Uint8Array | undefined;
  text: string;
  size: number;
}

const MAX_ROWS = 10000;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_ROW_BYTES = 64 * 1024;

/** 会话搜索的有界内存正文索引。以本次快照的原始正文核对索引项，再复用字面搜索文本。 */
export class RecordSearchIndex {
  private readonly rows = new Map<string, IndexedText>();
  private bytes = 0;

  get(key: string, body: Uint8Array | undefined): string | undefined {
    const row = this.rows.get(key);
    if (!row) return;
    if (row.body !== body && (!row.body || !body || Buffer.compare(row.body, body) !== 0)) return;
    this.rows.delete(key);
    this.rows.set(key, row);
    return row.text;
  }

  set(key: string, body: Uint8Array | undefined, text: string): void {
    const previous = this.rows.get(key);
    if (previous) {
      this.rows.delete(key);
      this.bytes -= previous.size;
    }
    const size = (body?.byteLength ?? 0) + text.length * 2;
    if (size > MAX_ROW_BYTES) return;
    while (this.rows.size >= MAX_ROWS || this.bytes + size > MAX_BYTES) {
      const oldest = this.rows.entries().next().value;
      if (!oldest) break;
      this.rows.delete(oldest[0]);
      this.bytes -= oldest[1].size;
    }
    // 按视图范围持有正文，避免单条消息意外留住绑定层分配的整片缓冲区。
    this.rows.set(key, { body: body && Uint8Array.from(body), text, size });
    this.bytes += size;
  }
}
