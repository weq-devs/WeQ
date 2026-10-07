/** 临时排查：让 native 组一个 type12/et1 的 SSO 帧，看它自己的头部布局，和抓包帧对照。用完即删。 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const p = resolve(process.cwd(), 'native/linux/x64/nt_helper.node');
process.chdir(dirname(p));
const require = createRequire(import.meta.url);
const addon = require(p);

const cfg = JSON.parse(
  readFileSync(`${process.env.HOME}/.config/weq/config/accounts/1707889225_03ed321f.json`, 'utf8'),
);
const s = cfg.session;
const hexBuf = (h) => Buffer.from(h, 'hex');

const session = {
  uin: cfg.uin,
  a2: hexBuf(s.a2),
  d2: hexBuf(s.d2),
  d2Key: hexBuf(s.d2Key),
  guid: cfg.guid,
  uid: cfg.uid,
  subAppId: 537391664,
};

const ch = (c) => (c >= 0x20 && c <= 0x7e ? String.fromCharCode(c) : '.');
const dumpHead = (label, buf, n) => {
  console.log(`--- ${label}（前 ${n} B）---`);
  for (let o = 0; o < Math.min(buf.length, n); o += 16) {
    const row = buf.subarray(o, Math.min(o + 16, buf.length));
    console.log(
      `${o.toString(16).padStart(4, '0')}  ${[...row]
        .map((b) => b.toString(16).padStart(2, '0'))
        .join(' ')
        .padEnd(47)}  ${[...row].map(ch).join('')}`,
    );
  }
};

for (const et of [0, 1]) {
  try {
    const pkt = addon.buildSsoPacket({
      session,
      command: 'Heartbeat.Alive',
      requestType: 12,
      encryptType: et,
      body: Buffer.from('00', 'hex'),
      sequence: 0x1791374536,
      needSign: false,
    });
    console.log(`\n======== native buildSsoPacket type12 et${et} · ${pkt.length} B ========`);
    dumpHead(`native 组帧 et${et}`, pkt, 160);
    // 找 uin 位置
    const needle = Buffer.from(cfg.uin, 'ascii');
    console.log(`  uin "${cfg.uin}" @ ${pkt.indexOf(needle)}`);
  } catch (e) {
    console.log(`et${et} buildSsoPacket 抛错: ${e.message}`);
  }
}
