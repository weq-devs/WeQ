/**
 * `direct_node_list_table` (in guild_msg.db) - the 频道私聊 conversation list.
 *
 * Column map (subset we read):
 *   40022  directGid     (TEXT, PRIMARY KEY)
 *   40027  nodeId        (INTEGER - partition key into guild_msg_table)
 *   40021  nodeIdText    (TEXT - same id, string form)
 *   40050  lastTime      (INTEGER, unix seconds)
 *   40003  lastSeq       (INTEGER)
 *   42051  peerTinyId    (INTEGER - profile key in guild1.db CommonUserProfile)
 *   42052  guildId       (INTEGER)
 *   42053  guildName     (TEXT)
 *   42054  nickGlobal    (TEXT)
 *   42055  nickChannel   (TEXT)
 *   40051  preview       (BLOB - guild "latest message" envelope; the preview
 *                           element(s) sit one level deeper, see
 *                           proto/guild/direct_preview.ts)
 *
 * This table is THE source of truth for the DM list. Consumers must never
 * derive sessions by scanning guild_msg_table for matching features.
 */

import { ProtoMsg, decodePreviewElement } from '@weq/codec';
import type { PreviewElement } from '@weq/codec';
import { sanitizeBytes } from '@weq/codec/raw';
import { RecentContactBody } from '@weq/codec/proto/msg/40051';
import { DirectNodePreviewBody } from '@weq/codec/proto/guild/direct_preview';
import type { DatabaseAlgorithms, NtHelperBinding, SqlRow, SqlValue } from '@weq/native';
import type { GuildDirectSession } from './types';
import { QqDb } from '../qq_db';
import { toBigint, toStr } from '../msg/util';

const SELECT_COLUMNS = `"40022","40027","40021","40050","40003","42051","42052","42053","42054","42055","40051"`;
const previewCodec = new ProtoMsg(RecentContactBody);
const envelopeCodec = new ProtoMsg(DirectNodePreviewBody);

export interface GuildDirectNodeDbOptions {
  /** Absolute path to guild_msg.db. */
  dbPath: string;
  /** SQLCipher key (omit for plain decrypted). */
  key?: string;
  /** Database algorithms (omit for plain decrypted). */
  algo?: DatabaseAlgorithms;
}

/** 频道私聊 conversation list accessor (guild_msg.db). */
export class GuildDirectNodeDb {
  private readonly qq: QqDb;

  constructor(nt: NtHelperBinding, opts: GuildDirectNodeDbOptions) {
    this.qq = new QqDb(nt, { dbPath: opts.dbPath, key: opts.key, algo: opts.algo });
  }

  /** Every DM conversation, newest first (40050 DESC). The list is tiny. */
  async listSessions(): Promise<GuildDirectSession[]> {
    const rows = await this.qq.query(
      `SELECT ${SELECT_COLUMNS} FROM direct_node_list_table
        ORDER BY "40050" DESC`,
    );
    return rows.map(rowToGuildDirectSession);
  }

  /** Drop the cached native connection. */
  close(): void {
    this.qq.close();
  }
}

function rowToGuildDirectSession(row: SqlRow): GuildDirectSession {
  return {
    directGid: toStr(row[0]),
    nodeId: toBigint(row[1]),
    lastTime: toBigint(row[3]),
    lastSeq: toBigint(row[4]),
    peerTinyId: toBigint(row[5]),
    guildId: toBigint(row[6]),
    guildName: toStr(row[7]),
    nickGlobal: toStr(row[8]),
    nickChannel: toStr(row[9]),
    preview: decodePreview(row[10]),
  };
}

function decodePreview(blob: SqlValue | undefined): PreviewElement | null {
  if (!(blob instanceof Uint8Array)) return null;
  // Guild cache: top-level tag 40051 is a message envelope whose own tag 40051
  // repeats the preview element wires. Decode that shape first.
  try {
    const decoded = envelopeCodec.decode(sanitizeBytes(blob, DirectNodePreviewBody));
    const elements = (decoded.nodes ?? [])
      .flatMap((node) => node.elements ?? [])
      .map((wire) => (wire ? decodePreviewElement(wire) : null))
      .filter((el): el is PreviewElement => el !== null);
    if (elements.length > 0) return pickPreviewElement(elements);
  } catch (e) {
    console.error('[GuildDirectNodeDb] failed to decode guild 40051 envelope:', e);
  }
  // Fallback: some rows store element wires directly at the top level, the
  // same shape as the recent-contact preview column.
  try {
    // Sanitize first so one mis-declared tag cannot derail the decode.
    const decoded = previewCodec.decode(sanitizeBytes(blob, RecentContactBody));
    const elements = (decoded.preview ?? [])
      .map((wire) => (wire ? decodePreviewElement(wire) : null))
      .filter((el): el is PreviewElement => el !== null);
    return pickPreviewElement(elements);
  } catch (e) {
    console.error('[GuildDirectNodeDb] failed to decode 40051 preview:', e);
    return null;
  }
}

/** Prefer a text-bearing element, else the element the list can display. */
function pickPreviewElement(elements: PreviewElement[]): PreviewElement | null {
  if (elements.length === 0) return null;
  const textEl = elements.find(
    (el) =>
      el.kind === 'text' && typeof el.textContent === 'string' && el.textContent.trim().length > 0,
  );
  if (textEl) return textEl;
  return (
    elements.find((el) => typeof el.displayText === 'string' && el.displayText.trim().length > 0) ??
    elements[0] ??
    null
  );
}
