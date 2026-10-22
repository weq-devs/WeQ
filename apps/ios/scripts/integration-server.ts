/** 仅用于本机模拟器测试，不是产品服务；明确开启后才自动批准测试设备。 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { RemotePairing } from '../../desktop/src/main/remote/pairing';
import { createRemoteServer } from '../../desktop/src/main/remote/http';

const pairing = new RemotePairing();
const backend = createRemoteServer(pairing);
function testNetwork(): { endpoint: string; control: string } | null {
  try {
    return JSON.parse(
      readFileSync(
        process.env.WEQ_REMOTE_TEST_CONFIG ??
          new URL('../.build/network-test.json', import.meta.url),
        'utf8',
      ),
    );
  } catch {
    return null;
  }
}
const fixture = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/test/network') {
    const network = testNetwork();
    res.writeHead(network ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(network));
    return;
  }
  if (req.method === 'GET' && req.url === '/test/invitation') {
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
    pairing.clear();
    res.writeHead(204).end();
    return;
  }
  backend.emit('request', req, res);
});
const timer = setInterval(() => {
  for (const pending of pairing.snapshot().pending) pairing.decide(pending.id, true);
}, 100);
fixture.listen(45198, '127.0.0.1', () =>
  console.log('iOS integration fixture listening on loopback:45198 (no TS registration)'),
);
function stop() {
  clearInterval(timer);
  pairing.clear();
  fixture.close();
  fixture.closeAllConnections();
}
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
