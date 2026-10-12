/**
 * Collection database (`collection.db → collection_list_info_table`).
 *
 * QQ 收藏. Each row carries scalar metadata plus two protobuf BLOB columns:
 *   180004 → author/owner identity
 *   180015 → content summary (a tagged union keyed by `type`)
 *
 * Decoding goes through the lenient schema-driven assembler (see `./assemble`)
 * so trailing-padded bodies (e.g. locations) survive.
 */

import type { DatabaseAlgorithms, NtHelperBinding, SqlRow } from '@weq/native';
import {
  CollectionAudioContentColumn,
  CollectionAuthorColumn,
  CollectionContentColumn,
  CollectionRichMediaContentColumn,
  CollectionTextContentColumn,
} from '@weq/codec/proto/collection/index';
import { QqDb } from '../qq_db';
import { decodeMessage } from './assemble';

const TABLE = 'collection_list_info_table';
const CONTENT_TABLE = 'content_list_info_table';

// cid, type, createTime, collectTime, modifyTime, author-blob, content-blob
const SELECT_COLUMNS = `"180001","180002","180009","180010","180012","180004","180015"`;

export type CollectionKind =
  | 'text'
  | 'link'
  | 'gallery'
  | 'audio'
  | 'video'
  | 'file'
  | 'location'
  | 'richMedia'
  | 'unknown';

const KIND_BY_TYPE: Record<number, CollectionKind> = {
  1: 'text',
  2: 'link',
  3: 'gallery',
  4: 'audio',
  5: 'video',
  6: 'file',
  7: 'location',
  8: 'richMedia',
};

/** Owner / author identity block. */
export interface CollectionAuthor {
  groupId?: bigint;
  groupName?: string;
  uid?: string;
  type?: number;
  numId?: bigint;
  strId?: string;
}

/** Image descriptor. */
export interface CollectionPicInfo {
  uri?: string;
  md5?: Uint8Array;
  sha1?: Uint8Array;
  name?: string;
  note?: string;
  width?: number;
  height?: number;
  size?: number;
  type?: number;
  owner?: CollectionAuthor;
  picId?: string;
  savePath?: string;
}

/** Stored-file descriptor. */
export interface CollectionFileInfo {
  src?: number;
  uid?: bigint;
  bid?: number;
  fid?: string;
  name?: string;
  size?: bigint;
  md5?: Uint8Array;
  sha1?: Uint8Array;
  category?: number;
  ntUid?: string;
  savePath?: string;
  defaultPath?: string;
  thumbPicPath?: string;
}

export interface TextSummary {
  text?: string;
  /** Collector summary may explicitly report truncation; absence does not prove full content. */
  truncated?: boolean;
}
export interface LinkSummary {
  url?: string;
  title?: string;
  publisher?: string;
  brief?: string;
  picList?: CollectionPicInfo[];
  type?: number;
}
export interface GallerySummary {
  picList?: CollectionPicInfo[];
}
export interface AudioSummary {
  duration?: number;
  stt?: string;
  extra?: string;
}
export interface VideoSummary {
  title?: string;
  duration?: number;
  format?: number;
  category?: number;
  previewType?: number;
  previewPicInfo?: CollectionPicInfo;
  storeType?: number;
  storeFileInfo?: CollectionFileInfo;
}
export interface FileSummary {
  fileInfo?: CollectionFileInfo;
  srcFileInfo?: CollectionFileInfo;
}
export interface LocationSummary {
  name?: string;
  latitude?: number;
  longitude?: number;
  altitude?: number;
  address?: string;
  note?: string;
}
export interface RichMediaSummary {
  title?: string;
  subTitle?: string;
  brief?: string;
  picList?: CollectionPicInfo[];
  contentType?: number;
  originalUri?: string;
  publisher?: string;
  richMediaVersion?: number;
}

/** The content union. Exactly one field is populated, matching `type`. */
export interface CollectionContent {
  textSummary?: TextSummary;
  linkSummary?: LinkSummary;
  gallerySummary?: GallerySummary;
  audioSummary?: AudioSummary;
  videoSummary?: VideoSummary;
  fileSummary?: FileSummary;
  locationSummary?: LocationSummary;
  richMediaSummary?: RichMediaSummary;
}

/**
 * Full-detail payloads cached by the official QQ client after a user opens a
 * collection item. Each of the eight BLOB columns contains its own protobuf
 * envelope, distinct from the list-summary protobuf.
 *
 * The bytes stay lossless here. Higher layers may decode UTF-8 text/HTML for
 * display, while unknown/binary variants remain available without guessing a
 * schema. Presence proves that QQ cached a detail response; it does not prove
 * that every referenced media original was downloaded.
 */
export interface CollectionCachedContent {
  /** QQ's content-row timestamp (`180720`); observed to match collectTime. */
  recordTime: number;
  text?: Uint8Array;
  link?: Uint8Array;
  gallery?: Uint8Array;
  audio?: Uint8Array;
  video?: Uint8Array;
  file?: Uint8Array;
  location?: Uint8Array;
  richMedia?: Uint8Array;
  textContent?: { data?: string; hasEmoji?: boolean };
  audioContent?: { data?: string };
  richMediaContent?: {
    rawData?: string;
    bizDataList?: string[];
    picList?: CollectionPicInfo[];
    fileList?: CollectionFileInfo[];
  };
}

/** One decoded collection item. */
export interface CollectionItem {
  /** Collection id, e.g. `1-1-<uuid>`. */
  cid: string;
  /** Numeric content type (1..8). */
  type: number;
  /** Human label of the active summary. */
  kind: CollectionKind;
  /** Content creation time (ms). */
  createTime: number;
  /** Time the item was collected (ms). */
  collectTime: number;
  /** Last modification time (ms). */
  modifyTime: number;
  /** Exact native sequence, when the source provides it; never round through Number. */
  sequence?: string;
  /** Exact native modification time for detail requests, separate from the ms projection. */
  nativeModifyTime?: string;
  /** Author/owner, or null if the column was empty. */
  author: CollectionAuthor | null;
  /** Decoded content summary (one field set). */
  summary: CollectionContent;
  /** Official-client detail cache, present only after QQ loaded this item. */
  cachedContent?: CollectionCachedContent;
}

export interface CollectionDbOptions {
  dbPath: string;
  key?: string;
  algo?: DatabaseAlgorithms;
}

function rowToItem(row: SqlRow): CollectionItem {
  const type = Number(row[1] ?? 0);
  const authorBlob = row[5];
  const contentBlob = row[6];

  const author =
    authorBlob instanceof Uint8Array
      ? ((decodeMessage(authorBlob, CollectionAuthorColumn).author as
          | CollectionAuthor
          | undefined) ?? null)
      : null;
  const summary =
    contentBlob instanceof Uint8Array
      ? ((decodeMessage(contentBlob, CollectionContentColumn).content as
          | CollectionContent
          | undefined) ?? {})
      : {};

  return {
    cid: String(row[0] ?? ''),
    type,
    kind: KIND_BY_TYPE[type] ?? 'unknown',
    createTime: Number(row[2] ?? 0),
    collectTime: Number(row[3] ?? 0),
    modifyTime: Number(row[4] ?? 0),
    author,
    summary,
  };
}

const CONTENT_SLOTS = [
  'text',
  'link',
  'gallery',
  'audio',
  'video',
  'file',
  'location',
  'richMedia',
] as const;

function contentBytes(value: SqlRow[number] | undefined): Uint8Array | undefined {
  if (value instanceof Uint8Array && value.byteLength > 0) return value;
  if (typeof value === 'string' && value.length > 0) return new TextEncoder().encode(value);
  return undefined;
}

function rowToCachedContent(row: SqlRow): [string, CollectionCachedContent] | null {
  const cid = String(row[0] ?? '');
  if (!cid) return null;
  const content: CollectionCachedContent = { recordTime: Number(row[1] ?? 0) };
  let present = false;
  for (let index = 0; index < CONTENT_SLOTS.length; index++) {
    const bytes = contentBytes(row[index + 2]);
    if (!bytes) continue;
    const slot = CONTENT_SLOTS[index]!;
    content[slot] = bytes;
    if (slot === 'text') {
      content.textContent = decodeMessage(bytes, CollectionTextContentColumn).content as
        | CollectionCachedContent['textContent']
        | undefined;
    } else if (slot === 'audio') {
      content.audioContent = decodeMessage(bytes, CollectionAudioContentColumn).content as
        | CollectionCachedContent['audioContent']
        | undefined;
    } else if (slot === 'richMedia') {
      content.richMediaContent = decodeMessage(bytes, CollectionRichMediaContentColumn).content as
        | CollectionCachedContent['richMediaContent']
        | undefined;
    }
    present = true;
  }
  return present ? [cid, content] : null;
}

export class CollectionDb {
  private readonly qq: QqDb;

  constructor(nt: NtHelperBinding, opts: CollectionDbOptions) {
    this.qq = new QqDb(nt, { dbPath: opts.dbPath, key: opts.key, algo: opts.algo });
  }

  /**
   * Whether `collection_list_info_table` is actually there.
   *
   * QQ only creates `collection.db` (and this table inside it) once 收藏 has
   * been opened at least once on this machine. Before that the file is absent
   * or empty — that means "no favourites", not a failure, so both readers below
   * degrade to an empty result instead of throwing.
   */
  private async tableExists(): Promise<boolean> {
    try {
      const rows = await this.qq.query(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`,
        [TABLE],
      );
      return rows.length > 0;
    } catch {
      return false;
    }
  }

  private async contentTableExists(): Promise<boolean> {
    try {
      const rows = await this.qq.query(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`,
        [CONTENT_TABLE],
      );
      return rows.length > 0;
    } catch {
      return false;
    }
  }

  /** Read lossless official-client detail-cache rows for the requested CIDs. */
  async cachedContentByCids(
    cids: readonly string[],
  ): Promise<Map<string, CollectionCachedContent>> {
    const unique = [...new Set(cids.filter(Boolean))];
    const result = new Map<string, CollectionCachedContent>();
    if (unique.length === 0 || !(await this.contentTableExists())) return result;
    const placeholders = unique.map(() => '?').join(',');
    const rows = await this.qq.query(
      `SELECT "180700","180720","180701","180702","180703","180704","180705","180706","180707","180708" FROM ${CONTENT_TABLE} WHERE "180700" IN (${placeholders})`,
      unique,
    );
    for (const row of rows) {
      const entry = rowToCachedContent(row);
      if (entry) result.set(...entry);
    }
    return result;
  }

  /** Read one cached detail row, or null when QQ has not opened the item. */
  async cachedContent(cid: string): Promise<CollectionCachedContent | null> {
    return (await this.cachedContentByCids([cid])).get(cid) ?? null;
  }

  /** Re-read one collection and its detail cache when the user opens it. */
  async getByCid(cid: string): Promise<CollectionItem | null> {
    if (!(await this.tableExists())) return null;
    const rows = await this.qq.query(
      `SELECT ${SELECT_COLUMNS} FROM ${TABLE} WHERE "180001" = ? LIMIT 1`,
      [cid],
    );
    if (!rows[0]) return null;
    const item = rowToItem(rows[0]);
    const content = await this.cachedContent(cid);
    if (content) item.cachedContent = content;
    return item;
  }

  /** Total number of collected items (0 when the database/table is absent). */
  async count(): Promise<number> {
    if (!(await this.tableExists())) return 0;
    const rows = await this.qq.query(`SELECT COUNT(*) FROM ${TABLE}`);
    return Number(rows[0]?.[0] ?? 0);
  }

  /**
   * List collected items, newest-collected first. Empty when the
   * database/table is absent.
   *
   * @param limit  page size
   * @param offset rows to skip
   */
  async listAll(limit = 50, offset = 0): Promise<CollectionItem[]> {
    if (!(await this.tableExists())) return [];
    const rows = await this.qq.query(
      `SELECT ${SELECT_COLUMNS} FROM ${TABLE} ORDER BY "180010" DESC LIMIT ? OFFSET ?`,
      [limit, offset],
    );
    const items = rows.map(rowToItem);
    const cached = await this.cachedContentByCids(items.map((item) => item.cid));
    for (const item of items) {
      const content = cached.get(item.cid);
      if (content) item.cachedContent = content;
    }
    return items;
  }

  close(): void {
    this.qq.close();
  }
}
