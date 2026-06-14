/**
 * TestMsgService — a deliberately dumb service used to verify the
 * AccountSession → C2cMsgDb → codec → JSON pipeline end-to-end.
 *
 * Calls `c2cMsgs.listRecent(limit)` and JSON-stringifies the whole
 * `C2cMsg[]` for the renderer. No field filtering, no DTO shaping — that
 * comes once we have a real MsgService.
 *
 * The only non-obvious bit is the `bigint` → `string` replacer: ids and
 * timestamps are `bigint` in `C2cMsg` to keep i64 precision, but
 * `JSON.stringify` throws on them. The replacer converts to string at
 * the serialization boundary; the renderer parses them back as strings
 * (it doesn't need arithmetic, just identity).
 */

import type { AccountSession } from '@weq/account';
import { bumpMaxMsgId } from './msg';

export class TestMsgService {
  constructor(private readonly session: AccountSession) {}

  /** Newest-first dump of recent c2c messages as a JSON string. */
  async dumpRecent(limit = 50): Promise<string> {
    const msgs = await this.session.c2cMsgs.listRecent(limit);
    // Reading the latest → advance the watch baseline so the file-watcher
    // hook doesn't re-push these as "new".
    bumpMaxMsgId(this.session.lastMsgIdMaps, 'c2cMsgId', msgs);
    return JSON.stringify(msgs, bigintReplacer, 2);
  }
}

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}
