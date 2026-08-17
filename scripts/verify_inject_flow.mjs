// End-to-end verification of the linux elevated-inject flow, exercising the
// ACTUAL built artifacts and the real production path:
//
//   1. probe a live QQ pid                                    (unprivileged)
//   2. pkexec env ELECTRON_RUN_AS_NODE=1 <electron> injectWorker.mjs  (ROOT)
//   3. fetchClientKey                                         (unprivileged)
//
// This mirrors the unprivileged-host branch of createLinuxInjectHook. Run it AFTER
// `electron-vite build` (needs out/main/injectWorker.mjs). Requires a graphical
// polkit agent (a password dialog pops once) and a logged-in QQ.
//
// Usage:  node scripts/verify_inject_flow.mjs
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const REPO = new URL('..', import.meta.url).pathname;
const NT_HELPER = join(REPO, 'native', 'linux', 'x64', 'nt_helper.node');
const WORKER = join(REPO, 'apps', 'desktop', 'out', 'main', 'injectWorker.mjs');
const ELECTRON = join(REPO, 'apps', 'desktop', 'node_modules', 'electron', 'dist', 'electron');

const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 23)}]`, ...a);

function pkexecInject(pid, uin) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'pkexec',
      ['env', 'ELECTRON_RUN_AS_NODE=1', ELECTRON, WORKER, String(pid), uin, NT_HELPER],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    child.on('error', (e) => reject(new Error(`pkexec spawn failed: ${e.message}`)));
    child.on('close', (code) => {
      log(`worker exit code=${code}`);
      if (out.trim()) log('worker stdout:', out.trim());
      if (err.trim()) log('worker stderr:', err.trim());
      code === 0 ? resolve() : reject(new Error(`inject failed (code ${code})`));
    });
  });
}

async function main() {
  const nt = require(NT_HELPER);
  log('driver euid (should be non-root):', process.geteuid?.());
  const pids = nt.getQqProcesses();
  log('QQ pids:', pids);
  if (!pids.length) return log('no QQ running — start + log in first.');
  const pid = pids[0];
  const probe = nt.probeQqLoginInfo(pid);
  log('probe:', probe);
  const uin = probe?.uin;
  if (!uin) throw new Error('probe 没拿到 uin，无法注入（uin 现在必须由调用方传入）。');

  log('--- [1] pkexec inject (root, electron-as-node) ---');
  await pkexecInject(pid, uin);

  log('--- [2] fetchClientKey (unprivileged) ---');
  const ck = await nt.fetchClientKey(pid);
  log('fetchClientKey OK:', ck);
  log('>>> FULL FLOW CONFIRMED: elevated inject + unprivileged fetch <<<');
}

main().catch((e) => {
  log('FAILED:', e.message);
  process.exit(1);
});
