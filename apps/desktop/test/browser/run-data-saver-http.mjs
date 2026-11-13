import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const output = resolve(root, 'apps/desktop/out/data-saver-validation');
await mkdir(output, { recursive: true });
const temporary = await mkdtemp(resolve(output, 'http-'));
const vite = await createServer({ configFile: false, root, server: { watch: null, hmr: false } });
const size = 10 * 1024 * 1024 + 128 * 1024;
const requests = [];
let sent = 0;
const upstream = createHttpServer((req, res) => {
  const range = /^bytes=(\d+)-$/.exec(req.headers.range ?? '');
  let at = range ? Number(range[1]) : 0;
  requests.push({ range: req.headers.range, ifRange: req.headers['if-range'] });
  res.writeHead(range ? 206 : 200, {
    ETag: '"fixture-v1"',
    'Content-Length': size - at,
    ...(range ? { 'Content-Range': `bytes ${at}-${size - 1}/${size}` } : {}),
  });
  let timer;
  const next = () => {
    if (res.destroyed) return;
    if (at === size) {
      res.end();
      return;
    }
    const bytes = Math.min(16384, size - at);
    at += bytes;
    sent += bytes;
    const schedule = () => {
      timer = setTimeout(next, 1);
    };
    if (res.write(Buffer.alloc(bytes, 77))) schedule();
    else res.once('drain', schedule);
  };
  res.once('close', () => clearTimeout(timer));
  next();
});
try {
  await new Promise((done) => upstream.listen(0, '127.0.0.1', done));
  const { ManagedDownload } = await vite.ssrLoadModule(
    '/packages/service/src/common/managed_download.ts',
  );
  const { updateTransferPolicy } = await vite.ssrLoadModule(
    '/packages/service/src/common/transfer_policy.ts',
  );
  const cost = (restricted) => ({
    state: restricted ? 'restricted' : 'unrestricted',
    constrained: restricted,
    metered: false,
    source: 'synthetic-http',
  });
  const url = `http://127.0.0.1:${upstream.address().port}/file`;
  updateTransferPolicy('auto', cost(false));
  await new ManagedDownload().file(url, resolve(temporary, 'normal'));
  const normalBytes = sent;
  assert.equal(normalBytes, size);

  updateTransferPolicy('auto', cost(true));
  const savedRequests = requests.length;
  const before = sent;
  const reduced = new ManagedDownload({ total: size });
  const waiting = reduced.file(url, resolve(temporary, 'reduced'));
  await new Promise((done) => setTimeout(done, 100));
  assert.equal(requests.length, savedRequests, '省流量模式不发送大文件请求');
  assert.equal(sent - before, 0);
  const reducedAutomaticBytes = sent - before;
  reduced.continue();
  await waiting;

  updateTransferPolicy('auto', cost(false));
  let notify;
  const paused = new Promise((done) => {
    notify = done;
  });
  const transfer = new ManagedDownload({
    state: (state) => {
      if (state.paused) notify();
    },
  });
  let changed = false;
  const resumed = transfer.file(url, resolve(temporary, 'resumed'), {}, (received) => {
    if (!changed && received >= 65536) {
      changed = true;
      updateTransferPolicy('auto', cost(true));
    }
  });
  await paused;
  await new Promise((done) => setTimeout(done, 60));
  const pausedBytes = sent;
  await new Promise((done) => setTimeout(done, 60));
  assert.equal(sent, pausedBytes, '暂停后上游实际停止发送');
  updateTransferPolicy('auto', cost(false));
  await resumed;
  const content = await readFile(resolve(temporary, 'resumed'));
  assert.equal(content.length, size);
  assert.ok(content.every((byte) => byte === 77));
  const rangeRequests = requests.filter((request) => request.range);
  assert.equal(rangeRequests.length, 1);
  assert.equal(rangeRequests[0].ifRange, '"fixture-v1"');
  console.log(
    JSON.stringify({
      normalBytes,
      reducedAutomaticBytes,
      requests: requests.length,
      rangeRequests,
      resumedBytes: content.length,
    }),
  );
} finally {
  upstream.closeAllConnections();
  await new Promise((done) => upstream.close(done));
  await vite.close();
  await rm(temporary, { recursive: true, force: true });
}
