/** 临时排查：用正确的字段名 d2Key 显式传 key 抓包，验证解密恢复。用完即删。 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const CFG = '/home/h3cof6/.config/weq/config/accounts/1707889225_03ed321f.json';
const p = resolve(process.cwd(), 'native/linux/x64/nt_helper.node');
process.chdir(dirname(p));
const require = createRequire(import.meta.url);
const addon = require(p);

const cfg = JSON.parse(readFileSync(CFG, 'utf8'));
const D2KEY = cfg.session?.d2Key;
const PID = cfg.qqPid ?? 60951;

async function run(label, opts) {
  console.log(`\n===== ${label} =====`);
  try {
    console.log('startCapture =', JSON.stringify(await addon.startCapture(PID, opts)));
  } catch (e) {
    console.log('startCapture ERR:', e.message);
    return;
  }
  let cursor;
  const seen = [];
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const b = await addon.takeFrames(PID, { cursor, waitMs: 1500 }).catch(() => ({
      frames: [],
      nextCursor: cursor,
    }));
    cursor = b.nextCursor;
    seen.push(...b.frames);
  }
  await addon.stopCapture(PID).catch(() => {});
  const enc = seen.filter((x) => x.encryptType !== 0);
  const ok = enc.filter((x) => (x.plain?.length ?? 0) > 0);
  console.log(`  et≠0 ${enc.length} 帧，解出 plain ${ok.length}`);
  for (const f of ok.slice(0, 3))
    console.log(`    ${f.direction} cmd=${f.cmd ?? '-'} plain=${f.plain.length}`);
}

await run('d2Key（正确字段名）', { iface: 'auto', port: 'auto', d2Key: D2KEY });
await run('d2key（错误字段名，现状）', { iface: 'auto', port: 'auto', d2key: D2KEY });
