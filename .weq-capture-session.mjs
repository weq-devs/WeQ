/** 临时排查：setSsoSession 后 startCapture（不带 d2key），看 native 能否解出 plain。用完即删。 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const CFG = '/home/h3cof6/.config/weq/config/accounts/1707889225_03ed321f.json';
const p = resolve(process.cwd(), 'native/linux/x64/nt_helper.node');
process.chdir(dirname(p));
const require = createRequire(import.meta.url);
const addon = require(p);

const cfg = JSON.parse(readFileSync(CFG, 'utf8'));
const s = cfg.session;
const PID = cfg.qqPid ?? 60951;
const hexBuf = (h) => Buffer.from(h, 'hex');

async function collect(label) {
  console.log(`\n===== ${label} =====`);
  try {
    const sess = await addon.startCapture(PID, { iface: 'auto', port: 'auto' });
    console.log('startCapture =', JSON.stringify(sess));
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
  const withPlain = enc.filter((x) => (x.plain?.length ?? 0) > 0);
  console.log(`  et≠0 帧 ${enc.length}，native 解出 plain ${withPlain.length}`);
  for (const f of withPlain.slice(0, 3)) {
    console.log(`    ${f.direction} cmd=${f.cmd ?? '-'} plain=${f.plain.length}`);
  }
}

const session = {
  uin: cfg.uin,
  a2: hexBuf(s.a2),
  d2: hexBuf(s.d2),
  d2Key: hexBuf(s.d2Key),
  guid: cfg.guid,
  uid: cfg.uid,
  subAppId: 537391664,
};

try {
  await addon.setSsoSession(PID, session, null);
  console.log('setSsoSession ok; hasSsoSession =', await addon.hasSsoSession(PID));
} catch (e) {
  console.log('setSsoSession ERR:', e.message);
}

await collect('已登记 SSO 会话 + 不带 d2key');
