/**
 * Shared types for the export pipeline (`account/export`).
 *
 * The pipeline is deliberately split so every output format reuses the same
 * middle layer:
 *
 *   DB rows ──(MsgService)──► RenderGroupMsg ──(toExportedMessage)──►
 *     ExportedMessage ──(per-format exporter)──► file on disk
 *
 * `ExportedMessage` is the normalized, JSON-safe record every exporter consumes
 * (bigints stringified at the top level; element bigints handled at serialize
 * time). JSON / TXT / Excel / HTML all read from this, never from raw rows.
 */

import type { RenderElement } from '../msg_view';

/** Output formats, mirroring QCE (+ jsonl). html lands in a later step. */
export type ExportFormat = 'json' | 'jsonl' | 'txt' | 'csv' | 'xlsx' | 'html';

/** Conversation kind an export targets. */
export type ConvKind = 'group' | 'c2c';

/**
 * Inclusive send-time window for an export, in unix *seconds*. `null` on either
 * bound means open-ended; both null (or absent) means no time filtering.
 */
export interface ExportTimeRange {
  start: number | null;
  end: number | null;
}

/** One message, normalized for export. */
export interface ExportedMessage {
  /** Message id (40001), as a string. */
  msgId: string;
  /** Per-group sequence (40003), as a string. */
  msgSeq: string;
  /** Send time, unix seconds. */
  sendTime: number;
  /** Sender QQ number (40033), as a string. */
  senderUin: string;
  /** Sender NT uid (40020). */
  senderUid: string;
  /** Render-mapped elements (same shape the front-end consumes). */
  elements: RenderElement[];
}

/** Progress tick emitted while exporting. */
export interface ExportProgress {
  /** Messages written so far. */
  current: number;
  /** Human-readable status line. */
  message: string;
}

export type ProgressCallback = (progress: ExportProgress) => void;

/** Options shared by every group exporter. */
export interface GroupExportOptions {
  /** Group code (群号) to export. */
  groupCode: string;
  /** Absolute path of the file to write. */
  outputPath: string;
  /** Messages per DB round-trip (default 2000). */
  pageSize?: number;
  /** Progress callback. */
  onProgress?: ProgressCallback;
  /** Emit a progress tick every N messages (default 5000). */
  progressEvery?: number;
  /** When provided, each message's sender uin is collected (avatar export). */
  collectSenders?: Set<string>;
  /** Inclusive send-time window; messages outside it are skipped. */
  range?: ExportTimeRange;
  /** Stamp media elements with their bundle relative path (`data.localPath`). */
  withMediaPaths?: boolean;
}

/** Result of a completed export. */
export interface ExportResult {
  /** Absolute path of the written file. */
  filePath: string;
  /** Format that was produced. */
  format: ExportFormat;
  /** Number of messages written. */
  messageCount: number;
  /** Size of the output file in bytes. */
  fileSize: number;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
}
