import { MailFailure, type MailNotice } from './types';
import { count, mailEnvelope, object, text } from './wire';

export type MailSocketEvent =
  | { kind: 'baseline'; sequence: number; folderId: number }
  | { kind: 'mail'; sequence: number; notice: MailNotice }
  | { kind: 'changed'; sequence: number }
  | { kind: 'ignore'; sequence: number };

export function decodeMailSocketFrame(raw: string): MailSocketEvent {
  try {
    if (raw.length > 512 * 1024) throw new Error('size');
    const frame = object(JSON.parse(raw));
    if (typeof frame.content !== 'string') throw new Error('frame');
    if (frame.cmd === 0) {
      const body = mailEnvelope(JSON.parse(frame.content));
      return {
        kind: 'baseline',
        sequence: count(body.lastest_msg_seq),
        folderId: count(body.lastest_msg_dirid),
      };
    }
    const event = object(JSON.parse(Buffer.from(frame.content, 'base64').toString('utf8')));
    const sequence = count(event.z);
    if (text(event.cid) !== '148') return { kind: 'changed', sequence };
    const id = text(event.e);
    if (!id) return { kind: 'ignore', sequence };
    return {
      kind: 'mail',
      sequence,
      notice: {
        id,
        subject: text(event.u),
        sender: text(event.sn ?? event.sa),
        folderId: count(event.d) || 1,
      },
    };
  } catch (error) {
    if (error instanceof MailFailure) throw error;
    throw new MailFailure('business', '邮箱提醒响应无效。');
  }
}

/** 有界去重，不持久化正文和收件人；首次同步只建立基线。 */
export class MailNoticeCursor {
  sequence = 0;
  private readonly seen = new Set<string>();
  private initialized = false;
  get primed(): boolean {
    return this.initialized;
  }

  prime(ids: readonly string[]): void {
    for (const id of ids) this.remember(id);
    this.initialized = true;
  }

  accept(id: string): boolean {
    if (!id || this.seen.has(id)) return false;
    this.remember(id);
    return this.initialized;
  }

  private remember(id: string): void {
    if (!id) return;
    this.seen.add(id);
    if (this.seen.size > 2000) {
      const first = this.seen.keys().next().value;
      if (first) this.seen.delete(first);
    }
  }
}
