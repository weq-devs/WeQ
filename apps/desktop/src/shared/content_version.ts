import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import superjson from 'superjson';

const versions = new WeakMap<object, string>();
const messageVersions = new WeakMap<object, string>();

/** Hash the same wire representation on the host and on HTTP-only WebViews. */
export function contentVersion(value: object): string {
  const cached = versions.get(value);
  if (cached) return cached;
  const version = bytesToHex(sha256(utf8ToBytes(superjson.stringify(value))));
  versions.set(value, version);
  return version;
}

export const conditionalDirectories = [
  'listRecentContacts',
  'listTopContacts',
  'listAllGroups',
  'listBuddies',
  'listCategories',
  'listProfiles',
  'listHiddenSessions',
  'listDeletedSessions',
  'listOfficialAccounts',
  'listServiceAccounts',
  'guildDirectListSessions',
] as const;

export type ConditionalDirectory = (typeof conditionalDirectories)[number];

export function compareMessageWindow<T>(
  rows: T[],
  known: { count: number; version: string },
  limit: number,
  project: (rows: T[]) => object,
) {
  if (
    rows.length >= known.count &&
    contentVersion(project(rows.slice(0, known.count))) === known.version
  ) {
    if (rows.length === known.count) return { kind: 'unchanged' as const };
    if (rows.length < limit) return { kind: 'append' as const, rows: rows.slice(known.count) };
  }
  return { kind: 'replace' as const, rows };
}

/** The renderer adds resolved bubble assets; compare only the wire message fields. */
export function comparableMessages<
  T extends {
    msgId: string;
    msgSeq: string;
    senderUid: string;
    senderUin: string;
    sendTime: string;
    elements: unknown[];
    localSent?: boolean;
    source?: string;
    sourceFormat?: string;
    ntSeqVerified?: boolean;
    msgRandom?: string;
    clientSeq?: string;
    recall?: unknown;
    deletedKind?: string;
    setEmojiList?: unknown;
    decoration?: {
      bubbleId: number;
      fontId: number;
      widgetId: number;
      fontId1Raw?: number;
      fontId2Raw?: number;
    };
  },
>(rows: readonly T[]): string[] {
  return rows.map((row) => {
    const cached = messageVersions.get(row);
    if (cached) return cached;
    const dress = row.decoration;
    const version = contentVersion([
      row.msgId,
      row.msgSeq,
      row.senderUid,
      row.senderUin,
      row.sendTime,
      row.elements,
      row.localSent,
      row.source,
      row.sourceFormat,
      row.ntSeqVerified,
      row.msgRandom || '',
      row.clientSeq,
      row.recall,
      row.deletedKind,
      row.setEmojiList,
      dress && [dress.bubbleId, dress.fontId, dress.widgetId, dress.fontId1Raw, dress.fontId2Raw],
    ]);
    messageVersions.set(row, version);
    return version;
  });
}
