// QQ club parcel metadata crawler (Node stdlib only, no deps).
//
// Endpoint : https://i.gtimg.cn/club/item/parcel/{id%10}/{id}_android.json
// Saved    : id, name, mark, feetype  -> CSV
//
// Crawl strategy
// --------------
// Two dense id bands exist: A = 200000-209999, B = 230000-247884+ (grows over
// time), with a permanent empty gap 210000-229999 between them.
//
// - First run (CSV missing): crawl band A fully, then crawl OPEN upward from
//   SECOND_BAND_START (230000) until EMPTY_THRESHOLD consecutive misses.
// - Interrupted first run (CSV max still inside/below band A): finish the rest
//   of band A, then open-crawl band B. The gap is always jumped explicitly,
//   never by burning through 20000 empty ids.
// - Normal incremental run (CSV max already in band B): resume from max+1 and
//   open-crawl upward until EMPTY_THRESHOLD consecutive misses. Band A is never
//   re-crawled because it sits below the max.
//
// Only NEW ids above the current CSV max are ever fetched on later runs.
//
//   node scripts/parcel_crawler.mjs [--csv path] [-c N] [-n N] [-d secs]

import {
  existsSync,
  statSync,
  readFileSync,
  createWriteStream,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, isAbsolute } from 'node:path';

// ---- fixed knowledge about the dataset -------------------------------------
const FIRST_BAND = [200000, 209999]; // crawled once, on the very first run
const SECOND_BAND_START = 230000; // open-ended crawl begins here after the gap

// ---- defaults (all overridable via CLI) ------------------------------------
const DEFAULT_CSV = '../resources/emoji/market.csv';
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_EMPTY_THRESHOLD = 100; // consecutive misses that mean "reached end"
const DEFAULT_DELAY = 0.12; // polite per-request sleep (seconds), + jitter
const WINDOW = 40; // ids fetched per parallel batch
const RETRIES = 4; // retries for transient (non-404) failures
const ERROR_ABORT = 25; // consecutive hard errors -> abort (not "done")
const TIMEOUT = 15000; // ms
const UA =
  'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36';

const FIELDS = ['id', 'name', 'mark', 'feetype'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function urlFor(pid) {
  return `https://i.gtimg.cn/club/item/parcel/${pid % 10}/${pid}_android.json`;
}

function parseBody(buf) {
  // Decode robustly (utf-8 -> gbk -> replace) then JSON.parse. null on failure.
  let text = null;
  for (const enc of ['utf-8', 'gbk']) {
    try {
      text = new TextDecoder(enc, { fatal: true }).decode(buf);
      break;
    } catch {
      // try next encoding
    }
  }
  if (text === null) text = new TextDecoder('utf-8').decode(buf);
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Return ['hit', row] | ['empty', null] | ['error', null].
async function fetchOne(pid, delay) {
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
    try {
      const resp = await fetch(urlFor(pid), {
        headers: { 'User-Agent': UA },
        signal: ctrl.signal,
      });
      if (resp.status === 404) return ['empty', null]; // definitive miss
      if (!resp.ok) {
        // 429 / 5xx -> back off and retry
        await sleep((delay * (attempt + 1) * 3 + Math.random() * 0.4) * 1000);
        continue;
      }
      const buf = new Uint8Array(await resp.arrayBuffer());
      const d = parseBody(buf);
      if (d === null) return ['empty', null]; // 200 but unparseable -> missing
      if (!d.id) return ['empty', null];
      return [
        'hit',
        {
          id: String(d.id ?? ''),
          name: d.name ?? '',
          mark: d.mark ?? '',
          feetype: String(d.feetype ?? ''),
        },
      ];
    } catch {
      // network error / timeout -> back off and retry
      await sleep((delay * (attempt + 1) * 3 + Math.random() * 0.4) * 1000);
    } finally {
      clearTimeout(timer);
    }
  }
  return ['error', null];
}

// Fetch ids with a bounded worker pool; return Map pid -> [status, row].
async function fetchWindow(ids, concurrency, delay) {
  const out = new Map();
  let next = 0;
  async function worker() {
    while (next < ids.length) {
      const pid = ids[next++];
      await sleep((delay + Math.random() * delay) * 1000);
      out.set(pid, await fetchOne(pid, delay));
    }
  }
  const workers = [];
  for (let i = 0; i < Math.max(1, concurrency); i++) workers.push(worker());
  await Promise.all(workers);
  return out;
}

function readMaxId(path) {
  if (!existsSync(path)) return null;
  let mx = null;
  const lines = readFileSync(path, 'utf-8').split(/\r?\n/);
  let header = true;
  for (const line of lines) {
    if (header) {
      header = false;
      continue; // skip header row
    }
    if (!line) continue;
    const first = line.split(',')[0];
    const v = Number.parseInt(first, 10);
    if (Number.isNaN(v)) continue;
    if (mx === null || v > mx) mx = v;
  }
  return mx;
}

function csvField(value) {
  const s = String(value ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

class Writer {
  constructor(path) {
    const fresh = !existsSync(path) || statSync(path).size === 0;
    this.f = createWriteStream(path, { flags: 'a', encoding: 'utf-8' });
    if (fresh) this.f.write(`${FIELDS.join(',')}\n`);
    this.count = 0;
  }
  write(row) {
    this.f.write(`${FIELDS.map((k) => csvField(row[k])).join(',')}\n`);
    this.count++;
  }
  close() {
    return new Promise((resolve) => this.f.end(resolve));
  }
}

// ---- progress bars ---------------------------------------------------------
const BAR_WIDTH = 30;

function renderBar(done, total, suffix) {
  const ratio = total > 0 ? Math.min(1, done / total) : 0;
  const filled = Math.round(ratio * BAR_WIDTH);
  const bar = '#'.repeat(filled) + '-'.repeat(BAR_WIDTH - filled);
  const pct = (ratio * 100).toFixed(1).padStart(5);
  process.stdout.write(`\r  [${bar}] ${pct}%  ${suffix}`);
}

// Crawl an inclusive fixed range; no early stop (skip internal holes).
// Progress bar spans the whole range (e.g. all 10000 ids of band A).
async function crawlRange(a, b, writer, cfg, stats) {
  const total = b - a + 1;
  console.log(`[range] ${a}-${b}  (${total} 个)`);
  let pid = a;
  let done = 0;
  let consecErr = 0;
  while (pid <= b) {
    const ids = [];
    for (let i = pid; i < Math.min(pid + WINDOW, b + 1); i++) ids.push(i);
    const res = await fetchWindow(ids, cfg.concurrency, cfg.delay);
    for (const i of ids) {
      const [status, row] = res.get(i);
      if (status === 'hit') {
        writer.write(row);
        stats.hits++;
        consecErr = 0;
      } else if (status === 'empty') {
        stats.empty++;
        consecErr = 0;
      } else {
        consecErr++;
        if (consecErr >= ERROR_ABORT) {
          throw new Error(
            `aborting: ${consecErr} consecutive network errors near ${i}. ` +
              'CSV kept; just rerun to resume.',
          );
        }
      }
    }
    done += ids.length;
    renderBar(done, total, `hits=${stats.hits}`);
    pid += WINDOW;
  }
  process.stdout.write('\n');
}

// Crawl upward from start until EMPTY_THRESHOLD consecutive misses.
// Total is unknown, so the progress bar cycles every 100 ids (fills, then
// resets to zero) to show it's alive and advancing.
async function crawlOpen(start, writer, cfg, stats) {
  const CYCLE = 100;
  console.log(
    `[open ] from ${start}, stop after ${cfg.emptyThreshold} consecutive empty`,
  );
  let pid = start;
  let consecEmpty = 0;
  let consecErr = 0;
  let cycleDone = 0;
  while (consecEmpty < cfg.emptyThreshold) {
    const ids = [];
    for (let i = pid; i < pid + WINDOW; i++) ids.push(i);
    const res = await fetchWindow(ids, cfg.concurrency, cfg.delay);
    let stop = false;
    for (const i of ids) {
      const [status, row] = res.get(i);
      if (status === 'hit') {
        writer.write(row);
        stats.hits++;
        consecEmpty = 0;
        consecErr = 0;
      } else if (status === 'empty') {
        consecEmpty++;
        consecErr = 0;
        if (consecEmpty >= cfg.emptyThreshold) {
          stop = true;
          break;
        }
      } else {
        consecErr++;
        if (consecErr >= ERROR_ABORT) {
          throw new Error(
            `aborting: ${consecErr} consecutive network errors near ${i}. ` +
              'CSV kept; just rerun to resume.',
          );
        }
      }
    }
    cycleDone = (cycleDone + ids.length) % CYCLE; // wraps back to 0 every 100
    renderBar(
      cycleDone === 0 ? CYCLE : cycleDone,
      CYCLE,
      `hits=${stats.hits}  empty_streak=${consecEmpty}  @${pid + WINDOW}`,
    );
    if (stop) break;
    pid += WINDOW;
  }
  process.stdout.write('\n');
  console.log(
    `[open ] reached end near ${pid} (${cfg.emptyThreshold} empties in a row)`,
  );
}

// Return list of segments: ['range', a, b] or ['open', start].
function plan(maxId) {
  if (maxId === null) {
    return [
      ['range', FIRST_BAND[0], FIRST_BAND[1]],
      ['open', SECOND_BAND_START],
    ];
  }
  if (maxId < FIRST_BAND[1]) {
    // first crawl was interrupted inside band A -> finish A, then B
    return [
      ['range', maxId + 1, FIRST_BAND[1]],
      ['open', SECOND_BAND_START],
    ];
  }
  if (maxId < SECOND_BAND_START) {
    // finished A, gap not crossed yet
    return [['open', Math.max(maxId + 1, SECOND_BAND_START)]];
  }
  return [['open', maxId + 1]]; // normal incremental
}

function parseArgs(argv) {
  const cfg = {
    csv: DEFAULT_CSV,
    concurrency: DEFAULT_CONCURRENCY,
    emptyThreshold: DEFAULT_EMPTY_THRESHOLD,
    delay: DEFAULT_DELAY,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i];
    if (a === '--csv') cfg.csv = val();
    else if (a === '-c' || a === '--concurrency') cfg.concurrency = Number.parseInt(val(), 10);
    else if (a === '-n' || a === '--empty-threshold') cfg.emptyThreshold = Number.parseInt(val(), 10);
    else if (a === '-d' || a === '--delay') cfg.delay = Number.parseFloat(val());
  }
  return cfg;
}

async function main() {
  const cfg = parseArgs(process.argv.slice(2));

  // Resolve --csv relative to this script (matches the old Python default).
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const csvPath = isAbsolute(cfg.csv) ? cfg.csv : join(scriptDir, cfg.csv);

  const maxId = readMaxId(csvPath);
  const segments = plan(maxId);

  console.log(
    `csv=${csvPath}  current_max=${maxId}  concurrency=${cfg.concurrency}  ` +
      `delay=${cfg.delay}s  empty_threshold=${cfg.emptyThreshold}`,
  );
  console.log(`plan: ${JSON.stringify(segments)}`);

  const writer = new Writer(csvPath);
  const stats = { hits: 0, empty: 0 };
  const t0 = Date.now();

  let interrupted = false;
  const onSigint = () => {
    interrupted = true;
  };
  process.on('SIGINT', onSigint);

  try {
    for (const seg of segments) {
      if (interrupted) break;
      if (seg[0] === 'range') await crawlRange(seg[1], seg[2], writer, cfg, stats);
      else await crawlOpen(seg[1], writer, cfg, stats);
    }
  } finally {
    process.off('SIGINT', onSigint);
    await writer.close();
  }

  if (interrupted) console.log('\ninterrupted by user (CSV saved, rerun to resume)');

  const dt = (Date.now() - t0) / 1000;
  const newMax = readMaxId(csvPath);
  console.log(
    `done. new rows this run=${stats.hits}  empty_seen=${stats.empty}  ` +
      `new_max=${newMax}  elapsed=${dt.toFixed(0)}s`,
  );
}

main().catch((err) => {
  console.error(`\n${err.message ?? err}`);
  process.exit(1);
});
