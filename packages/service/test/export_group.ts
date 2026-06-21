/**
 * Real-data integration test for the export pipeline (JSON / JSONL / TXT).
 *
 * Exports a whole (large) group to temp files in each format and reports timing
 * / throughput / size — the point is to measure performance against real data,
 * not a mock. Same hardcoded credentials as the other service tests.
 *
 * Run:  pnpm --filter @weq/service test:export
 */

import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadNative } from '@weq/native';
import { GroupMsgDb } from '@weq/db';
import { MsgService } from '../src/account/msg';
import {
  exportGroupToJson,
  exportGroupToJsonl,
  exportGroupToTxt,
  type ExportResult,
} from '../src/account/export';

const UIN = '1707889225';
const KEY = '^;<kXZ;RI[@]yTD<';
const GROUP_CODE = '932791232';
const DB_PATH = String.raw`D:\estkim\T\Tencent Files\1707889225\nt_qq\nt_db\nt_msg.db`;

/** Parse-safe ceiling: don't readFileSync + parse files larger than this. */
const FULL_READ_LIMIT = 100 * 1024 * 1024;

/** Read the last `n` bytes of a file without loading the whole thing. */
function readTail(path: string, n: number): string {
  const fd = openSync(path, 'r');
  try {
    const size = statSync(path).size;
    const len = Math.min(n, size);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf-8');
  } finally {
    closeSync(fd);
  }
}

function logResult(r: ExportResult): void {
  const sec = r.durationMs / 1000 || 1;
  console.log(
    `  [${r.format.padEnd(5)}] ${String(r.messageCount).padStart(7)} msgs · ` +
      `${sec.toFixed(2)}s · ${Math.round(r.messageCount / sec)} msg/s · ` +
      `${(r.fileSize / 1024 / 1024).toFixed(2)} MB`,
  );
}

function fail(msg: string): never {
  throw new Error(msg);
}

/** json: closed array; full-parse + length match when small enough. */
function validateJson(r: ExportResult): void {
  if (r.messageCount <= 0) fail('json: exported 0 messages');
  if (!readTail(r.filePath, 8).includes(']')) fail('json: not a closed array');
  if (r.fileSize < FULL_READ_LIMIT) {
    const parsed = JSON.parse(readFileSync(r.filePath, 'utf-8')) as unknown[];
    if (!Array.isArray(parsed)) fail('json: not an array');
    if (parsed.length !== r.messageCount) fail(`json: ${parsed.length} != ${r.messageCount}`);
  }
}

/** jsonl: non-empty line count == messageCount; first & last lines parse. */
function validateJsonl(r: ExportResult): void {
  if (r.messageCount <= 0) fail('jsonl: exported 0 messages');
  if (r.fileSize < FULL_READ_LIMIT) {
    const lines = readFileSync(r.filePath, 'utf-8').split('\n').filter((l) => l.length > 0);
    if (lines.length !== r.messageCount) fail(`jsonl: ${lines.length} lines != ${r.messageCount}`);
    JSON.parse(lines[0]!);
    JSON.parse(lines[lines.length - 1]!);
  }
}

/** txt: non-empty; at least one line per message (text may add internal lines). */
function validateTxt(r: ExportResult): void {
  if (r.messageCount <= 0) fail('txt: exported 0 messages');
  if (r.fileSize <= 0) fail('txt: empty file');
  if (r.fileSize < FULL_READ_LIMIT) {
    const content = readFileSync(r.filePath, 'utf-8');
    const lines = content.split('\n').filter((l) => l.length > 0);
    if (lines.length < r.messageCount) fail(`txt: ${lines.length} lines < ${r.messageCount} msgs`);
    if (!content.includes('] ')) fail('txt: missing expected "[time] uin:" framing');
  }
}

async function main(): Promise<void> {
  const native = loadNative();
  const groupMsgsDb = new GroupMsgDb(native.ntHelper, {
    dbPath: DB_PATH,
    key: KEY,
    algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' },
  });

  // MsgService only touches `groupMsgs` for group queries; mock the rest.
  const session = { groupMsgs: groupMsgsDb, lastRowIdMaps: { groupRowId: 0n } } as any;
  const msgs = new MsgService(session);

  const stamp = Date.now();
  const out = (ext: string): string => join(tmpdir(), `weq-export-${GROUP_CODE}-${stamp}.${ext}`);

  console.log(`[test:export] group ${GROUP_CODE}\n`);
  try {
    const json = await exportGroupToJson(msgs, { groupCode: GROUP_CODE, outputPath: out('json'), pageSize: 2000 });
    logResult(json);
    validateJson(json);

    const jsonl = await exportGroupToJsonl(msgs, { groupCode: GROUP_CODE, outputPath: out('jsonl'), pageSize: 2000 });
    logResult(jsonl);
    validateJsonl(jsonl);

    const txt = await exportGroupToTxt(msgs, { groupCode: GROUP_CODE, outputPath: out('txt'), pageSize: 2000 });
    logResult(txt);
    validateTxt(txt);

    if (json.messageCount !== jsonl.messageCount || json.messageCount !== txt.messageCount) {
      fail(`message count mismatch across formats: json=${json.messageCount} jsonl=${jsonl.messageCount} txt=${txt.messageCount}`);
    }

    console.log('\n[test:export] sample txt lines:');
    if (txt.fileSize < FULL_READ_LIMIT) {
      const lines = readFileSync(txt.filePath, 'utf-8').split('\n').filter((l) => l.length > 0);
      for (const line of lines.slice(0, 5)) console.log(`    ${line.slice(0, 100)}`);
    }

    console.log('\n[test:export] PASS');
  } finally {
    groupMsgsDb.close();
  }
}

main().catch((e) => {
  console.error('[test:export] failed:', e);
  process.exit(1);
});
