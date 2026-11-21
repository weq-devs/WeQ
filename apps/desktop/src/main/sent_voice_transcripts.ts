import { JsonStore, type MsgService } from '@weq/service';
import { voiceFileHash } from '../shared/roaming_timeline';

type Receipt = {
  kind: 'c2c' | 'group';
  conv: string;
  at: number;
  text: string;
  hash: string;
  seq: string;
  random?: string;
};

type Target = { msgId: string; fileName: string };
type Pending = Receipt & { target?: Target; done?: boolean };
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const RETRY_MS = 1000;

/** 把合成原文交给 QQ 实际同步的那一行。账号切换或应用重启后继续等待落库。 */
export class SentVoiceTranscripts {
  private readonly store: JsonStore<Pending[]>;
  private timer?: ReturnType<typeof setTimeout>;
  private flight?: Promise<void>;
  private stopped = false;
  private delay = RETRY_MS;

  constructor(
    path: string,
    private readonly msgs: MsgService,
    private readonly selfUid: string,
    private readonly active: () => boolean,
  ) {
    this.store = new JsonStore<Pending[]>(path, () => [], {
      normalize: (value) => (Array.isArray(value) ? value : []),
    });
    this.prune();
    this.schedule(0);
  }

  remember(receipt: Receipt): void {
    if (this.stopped || !receipt.text.trim() || !this.selfUid) return;
    if (!receipt.random && !/^[a-f0-9]{32}$/.test(receipt.hash)) return;
    this.prune();
    this.store.data.push(receipt);
    this.store.save();
    this.delay = RETRY_MS;
    this.schedule(0);
  }

  async dispose(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.flight;
  }

  async flush(): Promise<void> {
    if (this.stopped || !this.active() || !this.store.data.some((item) => !item.done)) return;
    if (this.flight) return this.flight;
    this.flight = this.applyPending();
    try {
      await this.flight;
    } finally {
      this.flight = undefined;
      this.schedule(this.delay);
      this.delay = Math.min(60_000, this.delay * 2);
    }
  }

  private prune(): void {
    const now = Date.now();
    const keep = this.store.data.filter(
      (row) => row.at >= now - (row.done ? 5 * 60_000 : RETENTION_MS),
    );
    if (keep.length !== this.store.data.length) this.store.replace(keep);
  }

  private schedule(delay: number): void {
    clearTimeout(this.timer);
    if (this.stopped || !this.store.data.some((item) => !item.done)) return;
    this.timer = setTimeout(() => void this.flush(), delay);
    this.timer.unref();
  }

  private async applyPending(): Promise<void> {
    this.prune();
    const current = () => !this.stopped && this.active();
    const claimed = new Set(this.store.data.flatMap((item) => item.target?.msgId ?? []));
    for (const item of this.store.data) {
      if (!current()) return;
      if (item.done) continue;
      try {
        const found = item.target ?? (await this.findTarget(item, claimed));
        if (!found || !current()) continue;
        if (!item.target) {
          item.target = { msgId: found.msgId, fileName: found.fileName };
          claimed.add(found.msgId);
          this.store.save();
        }
        const elements = await this.msgs.getRawElements(BigInt(found.msgId));
        const voice = elements?.elements.find(
          (element) => element.kind === 'ptt' && element.fileName === found.fileName,
        );
        if (voice?.kind !== 'ptt' || !current()) continue;
        if (
          voice.pttTranscript === item.text ||
          (await this.msgs.setPttTranscript(BigInt(found.msgId), found.fileName, item.text, {
            current,
          }))
        ) {
          item.done = true;
          item.text = '';
          this.store.save();
        }
      } catch (error) {
        console.warn('[voice] 等待保存合成原文:', error);
      }
    }
  }

  private async findTarget(receipt: Receipt, claimed: Set<string>): Promise<Target | undefined> {
    const seq = BigInt(receipt.seq);
    const rows = receipt.random
      ? await this.msgs.getSentVoiceRows(receipt.kind, receipt.conv, seq)
      : await this.msgs.getGroupAfter(receipt.conv, seq, 200, { deferReplyMedia: true });
    for (const row of rows) {
      if (row.senderUid !== this.selfUid || claimed.has(String(row.msgId))) continue;
      if (receipt.random && String(row.msgRandom) !== receipt.random) continue;
      if (!receipt.random && Number(row.sendTime) < Math.floor(receipt.at / 1000) - 1) continue;
      const element = row.elements.find(
        (el) =>
          el.type === 'ptt' &&
          (receipt.random || (el.data.isAiVoice && voiceFileHash(el.data) === receipt.hash)),
      );
      if (element?.type === 'ptt' && element.data.fileName) {
        return { msgId: String(row.msgId), fileName: element.data.fileName };
      }
    }
  }
}
