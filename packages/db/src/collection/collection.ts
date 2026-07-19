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
  CollectionAuthorColumn,
  CollectionContentColumn,
} from '@weq/codec/proto/collection/index';
import { QqDb } from '../qq_db';
import { decodeMessage } from './assemble';

const TABLE = 'collection_list_info_table';

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
}
export interface LinkSummary {
  url?: string;
  title?: string;
  publisher?: string;
  brief?: string;
  picList?: CollectionPicInfo[];
  type?: number;
  resourceUrl?: string;
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
  /** Author/owner, or null if the column was empty. */
  author: CollectionAuthor | null;
  /** Decoded content summary (one field set). */
  summary: CollectionContent;
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
      ? ((decodeMessage(authorBlob, CollectionAuthorColumn).author as CollectionAuthor | undefined) ??
        null)
      : null;
  const summary =
    contentBlob instanceof Uint8Array
      ? ((decodeMessage(contentBlob, CollectionContentColumn).content as CollectionContent | undefined) ??
        {})
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

export class CollectionDb {
  private readonly qq: QqDb;

  constructor(nt: NtHelperBinding, opts: CollectionDbOptions) {
    this.qq = new QqDb(nt, { dbPath: opts.dbPath, key: opts.key, algo: opts.algo });
  }

  /** Total number of collected items. */
  async count(): Promise<number> {
    const rows = await this.qq.query(`SELECT COUNT(*) FROM ${TABLE}`);
    return Number(rows[0]?.[0] ?? 0);
  }

  /**
   * List collected items, newest-collected first.
   *
   * @param limit  page size
   * @param offset rows to skip
   */
  async listAll(limit = 50, offset = 0): Promise<CollectionItem[]> {
    const rows = await this.qq.query(
      `SELECT ${SELECT_COLUMNS} FROM ${TABLE} ORDER BY "180010" DESC LIMIT ? OFFSET ?`,
      [limit, offset],
    );
    return rows.map(rowToItem);
  }

  close(): void {
    this.qq.close();
  }
}
