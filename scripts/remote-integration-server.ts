/** 仅用于本机模拟器测试，不是产品服务；明确开启后才自动批准测试设备。 */
import { createServer } from 'node:http';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RemotePairing } from '../apps/desktop/src/main/remote/pairing';
import { createRemoteServer } from '../apps/desktop/src/main/remote/http';
import { DesktopWebRuntime } from '../apps/desktop/src/main/web/runtime';
import { webFixtureRouter } from '../apps/desktop/test/web_fixture';
import { fileURLToPath } from 'node:url';
import { RemoteRuntime } from '../apps/desktop/src/main/remote/runtime';

const lan = process.env.WEQ_REMOTE_LAN_TEST === '1' ? new RemoteRuntime() : null;
const directory = lan ? mkdtempSync(join(tmpdir(), 'weq-lan-smoke-')) : null;
const exportsDirectory = mkdtempSync(join(tmpdir(), 'weq-remote-fixture-'));
const pairing = lan?.pairing ?? new RemotePairing();
const web = new DesktopWebRuntime();
web.configure({
  publicDir: fileURLToPath(new URL('../apps/desktop/test/fixtures/remote-web', import.meta.url)),
  exportDir: exportsDirectory,
  version: 'fixture',
  pairing,
  router: webFixtureRouter,
  getAutoStart: () => false,
  setAutoStart: () => {},
});
await web.start();
if (lan && directory) {
  lan.configure({
    lanPort: 0,
    helper: fileURLToPath(new URL('../tools/remote-network/weq-remote-network', import.meta.url)),
    stateDir: directory,
    webPort: () => web.status().port,
  });
  await lan.start();
}
const backend = createRemoteServer(pairing, () => web.status().port);
function testNetwork(): { endpoint: string; control: string } | null {
  try {
    if (!process.env.WEQ_REMOTE_TEST_CONFIG) return null;
    return JSON.parse(readFileSync(process.env.WEQ_REMOTE_TEST_CONFIG, 'utf8'));
  } catch {
    return null;
  }
}
const fixture = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/test/contract') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ fixture: 1, protocol: 1, invitationVersions: [1, 2, 3] }));
    return;
  }
  if (req.method === 'GET' && req.url === '/test/devices') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ count: pairing.snapshot().devices.length }));
    return;
  }
  if (req.method === 'GET' && req.url === '/test/network') {
    const network = testNetwork();
    res.writeHead(network ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(network));
    return;
  }
  if (req.method === 'GET' && req.url === '/test/invitation') {
    if (lan) {
      try {
        const invitation = await lan.invite();
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ url: invitation.pairingURL }));
      } catch {
        res.writeHead(503).end();
      }
      return;
    }
    for (const device of pairing.snapshot().devices) pairing.revoke(device.id);
    pairing.clear();
    const invitation = pairing.invite();
    const url = new URL('weq-remote://pair');
    url.searchParams.set('v', '1');
    url.searchParams.set('endpoint', testNetwork()?.endpoint ?? 'http://100.64.0.10:7691');
    url.searchParams.set('invitation', invitation.secret);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ url: url.toString() }));
    return;
  }
  if (req.method === 'POST' && req.url === '/test/revoke') {
    for (const device of pairing.snapshot().devices) pairing.revoke(device.id);
    pairing.clear();
    res.writeHead(204).end();
    return;
  }
  backend.emit('request', req, res);
});
const timer = setInterval(() => {
  for (const pending of pairing.snapshot().pending) pairing.decide(pending.id, true);
}, 100);
fixture.on('upgrade', (req, socket, head) => backend.emit('upgrade', req, socket, head));
fixture.listen(Number(process.env.WEQ_REMOTE_TEST_PORT ?? '45198'), '127.0.0.1', () => {
  const address = fixture.address();
  if (address && typeof address !== 'string')
    console.log(JSON.stringify({ event: 'remote-fixture-ready', port: address.port, fixture: 1 }));
});
function stop() {
  clearInterval(timer);
  pairing.clear();
  web.stop();
  lan?.stop(true);
  if (directory) rmSync(directory, { recursive: true, force: true });
  rmSync(exportsDirectory, { recursive: true, force: true });
  fixture.close();
  fixture.closeAllConnections();
}
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
