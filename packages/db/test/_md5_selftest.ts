import { createHash } from 'node:crypto';
import { md5Hex16 } from './lib/md5_fast';
const out = new Uint8Array(16);
let ok = true;
for (const ts of [0, 1, 42, 1560759023, 1356998400, 2147483647, 999999999]) {
  md5Hex16(ts, out);
  const mine = Buffer.from(out).toString('latin1');
  const ref = createHash('md5').update(String(ts)).digest('hex').slice(0, 16);
  const pass = mine === ref;
  if (!pass) ok = false;
  console.log(`ts=${ts}\tmine=${mine}\tref=${ref}\t${pass ? 'OK' : 'FAIL'}`);
}
console.log(ok ? 'ALL PASS' : 'FAILED');
