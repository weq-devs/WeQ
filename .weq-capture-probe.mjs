/** 临时排查：startCapture 对 d2key 参数类型的要求。用完即删。 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const p = resolve(process.cwd(), 'native/linux/x64/nt_helper.node');
process.chdir(dirname(p));
const require = createRequire(import.meta.url);
const addon = require(p);

console.log('probeCaptureSupport =', JSON.stringify(addon.probeCaptureSupport()));

const cfg = JSON.parse(
  readFileSync(`${process.env.HOME}/.config/weq/config/accounts/1707889225_03ed321f.json`, 'utf8'),
);
const D2KEY = cfg.session.d2Key;

async function probe(label, opts) {
  try {
    const s = await addon.startCapture(999999, opts);
    console.log(`${label}: OK`, JSON.stringify(s));
    await addon.stopCapture(999999).catch(() => {});
  } catch (e) {
    console.log(`${label}: ERR ${e.message}`);
  }
}

await probe('d2key=string', { iface: 'auto', d2key: D2KEY, port: 'auto' });
await probe('d2key=Buffer', { iface: 'auto', d2key: Buffer.from(D2KEY, 'hex'), port: 'auto' });
await probe('d2key omitted', { iface: 'auto', port: 'auto' });
