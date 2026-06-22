/**
 * Concurrency / risk-control probe for rkey CDN downloads.
 *
 * Pulls the still-downloadable GROUP-IMAGE work-list out of {@link scanGroupMedia}
 * and downloads a bounded sample from QQ's multimedia CDN at escalating
 * concurrency (4 → 8 → 16 → 32), each wave over a DISTINCT slice (so CDN caching
 * doesn't flatter later waves). Reports success rate, latency p50/p95, and
 * classifies failures so risk-control signals (403/429, HTML error pages,
 * connection resets, timeouts, latency blow-up at higher concurrency) stand out.
 *
 * This hits the real CDN with YOUR rkey to download YOUR group's media. The
 * sample is capped and nothing is written to disk — it's a stability probe, not
 * a bulk fetch.
 *
 * Run:  pnpm --filter @weq/service test:download-probe
 */

import { resolve } from 'node:path';
import { loadNative } from '@weq/native';
import { GroupMsgDb } from '@weq/db';
import { MsgService } from '../src/account/msg';
import { scanGroupMedia, mediaDirsFromAccountDir, type MediaRef } from '../src/account/export';

const UIN = '1707889225';
const KEY = '^;<kXZ;RI[@]yTD<';
const GROUP_CODE = '932791232';
const DB_PATH = String.raw`D:\estkim\T\Tencent Files\1707889225\nt_qq\nt_db\nt_msg.db`;

// A live download rkey for GROUP images (type 20 → appid 1407).
const RKEY = '&rkey=CAQSMOmfS8Bbc37qQqHjZydpkVbmKPVZr2W76DMPhUm3ogxFFUoiSRDFj_sgcC7BzJa8AQ';
const RKEY_TYPE = 20;
const RKEY_CREATE_TIME = 1782078597;
const RKEY_TTL = 3420;

const MEDIA_HOST = 'https://multimedia.nt.qq.com.cn';
const REQ_TIMEOUT_MS = 20000;

/** Escalating concurrency levels; each wave uses a fresh slice of the list. */
const WAVES = [4, 8, 16, 32];
const PER_WAVE = 50;

/** Group scenes use appid 1407; private (c2c) use 1406. */
function buildUrl(fileToken: string): string {
  const appid = RKEY_TYPE >= 20 ? '1407' : '1406';
  return `${MEDIA_HOST}/download?appid=${appid}&fileid=${encodeURIComponent(fileToken)}&spec=0${RKEY}`;
}

type Klass = 'ok' | 'error_page' | 'empty' | 'timeout' | 'neterr' | string;

interface Probe {
  ms: number;
  bytes: number;
  klass: Klass;
  token: string;
  url: string;
}

function isAllDigits(s: string): boolean {
  return /^\d+$/.test(s);
}

async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function probeOne(token: string): Promise<Probe> {
  const url = buildUrl(token);
  const base = { token, url };
  const t0 = Date.now();
  try {
    const res = await fetchWithTimeout(url, REQ_TIMEOUT_MS);
    const ct = res.headers.get('content-type') ?? '';
    if (!res.ok) return { ...base, ms: Date.now() - t0, bytes: 0, klass: `http_${res.status}` };
    const buf = await res.arrayBuffer();
    const ms = Date.now() - t0;
    // A wrong/expired rkey commonly returns a 200 text/HTML/JSON error page.
    if (ct.startsWith('text/') || ct.includes('json')) return { ...base, ms, bytes: buf.byteLength, klass: 'error_page' };
    if (buf.byteLength === 0) return { ...base, ms, bytes: 0, klass: 'empty' };
    return { ...base, ms, bytes: buf.byteLength, klass: 'ok' };
  } catch (e) {
    const ms = Date.now() - t0;
    const name = e instanceof Error ? e.name : '';
    return { ...base, ms, bytes: 0, klass: name === 'AbortError' ? 'timeout' : 'neterr' };
  }
}

async function runWave(tokens: string[], concurrency: number): Promise<{ probes: Probe[]; wallMs: number }> {
  const probes: Probe[] = new Array(tokens.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, tokens.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= tokens.length) break;
      probes[i] = await probeOne(tokens[i]!);
    }
  });
  const t0 = Date.now();
  await Promise.all(workers);
  return { probes, wallMs: Date.now() - t0 };
}

function pct(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

/**
 * Risk-control / network failure (scales with concurrency): throttling (429),
 * blocking (403), 5xx, timeouts, connection resets. Distinct from per-item
 * errors (http_400 / error_page / empty) which are about a specific token.
 */
function isRiskFail(klass: string): boolean {
  return (
    klass === 'timeout' ||
    klass === 'neterr' ||
    klass === 'http_403' ||
    klass === 'http_429' ||
    klass.startsWith('http_5')
  );
}

function summarize(
  label: string,
  probes: Probe[],
  wallMs: number,
): { okRate: number; p95: number; riskFails: number; itemFails: number } {
  const n = probes.length;
  const byKlass = new Map<string, number>();
  let okBytes = 0;
  const okLat: number[] = [];
  for (const p of probes) {
    byKlass.set(p.klass, (byKlass.get(p.klass) ?? 0) + 1);
    if (p.klass === 'ok') {
      okBytes += p.bytes;
      okLat.push(p.ms);
    }
  }
  const ok = byKlass.get('ok') ?? 0;
  const okRate = n ? Math.round((ok / n) * 100) : 0;
  const p50 = pct(okLat, 50);
  const p95 = pct(okLat, 95);
  let riskFails = 0;
  let itemFails = 0;
  for (const [k, v] of byKlass) {
    if (k === 'ok') continue;
    if (isRiskFail(k)) riskFails += v;
    else itemFails += v;
  }
  const failParts = [...byKlass.entries()]
    .filter(([k]) => k !== 'ok')
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');

  console.log(
    `  ${label.padEnd(14)} n=${String(n).padStart(3)} ok=${String(ok).padStart(3)} (${okRate}%) ` +
      `wall=${(wallMs / 1000).toFixed(2)}s lat p50=${p50}ms p95=${p95}ms ` +
      `${(okBytes / 1024 / 1024).toFixed(1)}MB${failParts ? `  ⚠ ${failParts}` : ''}`,
  );
  return { okRate, p95, riskFails, itemFails };
}

async function main(): Promise<void> {
  const expiresInMin = Math.round((RKEY_CREATE_TIME + RKEY_TTL - Date.now() / 1000) / 60);
  console.log(`[probe] rkey type=${RKEY_TYPE} expires in ~${expiresInMin} min`);
  if (expiresInMin <= 0) {
    console.warn('[probe] ⚠ rkey appears EXPIRED — downloads will likely fail; re-supply a fresh rkey.');
  }

  const native = loadNative();
  const groupMsgsDb = new GroupMsgDb(native.ntHelper, {
    dbPath: DB_PATH,
    key: KEY,
    algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' },
  });
  const session = { groupMsgs: groupMsgsDb, lastRowIdMaps: { groupRowId: 0n } } as any;
  const msgs = new MsgService(session);
  const dirs = mediaDirsFromAccountDir(resolve(DB_PATH, '..', '..', '..'));

  try {
    console.log('[probe] scanning for downloadable group images…');
    const scan = await scanGroupMedia(msgs, GROUP_CODE, dirs, { pageSize: 2000 });
    const candidates: MediaRef[] = scan.downloadList.filter((m) => m.kind === 'pic' && m.fileToken.length > 0);
    console.log(`[probe] downloadable group-image candidates: ${candidates.length}\n`);

    if (candidates.length === 0) throw new Error('no downloadable group-image candidates to probe');

    const verdicts: Array<{ concurrency: number; okRate: number; p95: number; riskFails: number; itemFails: number }> = [];
    const allProbes: Probe[] = [];
    let offset = 0;
    for (const concurrency of WAVES) {
      const slice = candidates.slice(offset, offset + PER_WAVE);
      offset += PER_WAVE;
      if (slice.length === 0) break;
      const { probes, wallMs } = await runWave(slice.map((m) => m.fileToken), concurrency);
      allProbes.push(...probes);
      const s = summarize(`conc=${concurrency}`, probes, wallMs);
      verdicts.push({ concurrency, ...s });
    }

    // Per-item failures (http_400 etc.) — print the URLs so we can eyeball them.
    // Hunch: these are the digit-token "second image format" that QQ serves via
    // an external originalUrl and does NOT want an rkey — handled in the real
    // pipeline, out of scope for this probe.
    const itemFailProbes = allProbes.filter((p) => p.klass !== 'ok' && !isRiskFail(p.klass));
    if (itemFailProbes.length > 0) {
      console.log(`\n[probe] per-item failures (${itemFailProbes.length}) — constructed URLs:`);
      for (const p of itemFailProbes.slice(0, 12)) {
        console.log(`  [${p.klass}] digitToken=${isAllDigits(p.token)}  ${p.url}`);
      }
    }

    // ---- verdict ----
    // Risk-control is signalled by RISK-type failures (403/429/timeout/reset)
    // that scale with concurrency, and/or runaway latency — NOT by a few
    // per-item http_400s (specific bad tokens), which are unrelated to load.
    console.log('\n[probe] verdict:');
    const totalRisk = verdicts.reduce((s, v) => s + v.riskFails, 0);
    const totalItem = verdicts.reduce((s, v) => s + v.itemFails, 0);
    const firstP95 = verdicts[0]?.p95 ?? 0;
    const lastP95 = verdicts[verdicts.length - 1]?.p95 ?? 0;
    const latencyBlowup = firstP95 > 0 && lastP95 > firstP95 * 3;
    const maxConc = Math.max(...verdicts.map((v) => v.concurrency));

    if (totalRisk === 0 && !latencyBlowup) {
      console.log(`  ✓ 稳定，无风控迹象：并发至 ${maxConc} 无 403/429/超时/重置，延迟无系统性劣化。`);
    } else if (totalRisk === 0) {
      console.log(`  ✓ 无风控（无 403/429/超时），但延迟随并发上升（p95 ${firstP95}→${lastP95}ms）：建议限并发。`);
    } else {
      console.log(`  ✗ 疑似风控：风控类失败 ${totalRisk} 个（403/429/超时/重置）。建议限并发 + 退避重试。`);
    }
    if (totalItem > 0) {
      console.log(`  ℹ 另有 ${totalItem} 个个别 token 失败（http_400/error_page，与并发无关）：逐项跳过即可。`);
    }

    console.log('\n[probe] done');
  } finally {
    groupMsgsDb.close();
  }
}

main().catch((e) => {
  console.error('[probe] failed:', e);
  process.exit(1);
});
