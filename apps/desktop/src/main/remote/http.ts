import { createServer, type IncomingMessage } from 'node:http';
import { type RemotePairing, claimSchema } from './pairing';

function bearer(req: IncomingMessage): string {
  const value = req.headers.authorization ?? '';
  return /^Bearer [a-f0-9]{64}$/.test(value) ? value.slice(7) : '';
}

export function createRemoteServer(pairing: RemotePairing) {
  let windowStart = Date.now();
  let requests = 0;
  const server = createServer(async (req, res) => {
    const send = (code: number, value: unknown) => {
      res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(JSON.stringify(value));
    };
    // 原生客户端协议，不接受网页跨源调用，也不返回 CORS 授权。
    if (req.headers.origin) return send(403, { error: '不接受浏览器来源。' });
    if (Date.now() - windowStart >= 60_000) {
      windowStart = Date.now();
      requests = 0;
    }
    if (++requests > 120) return send(429, { error: '请求过于频繁。' });
    const path = req.url ?? '';
    try {
      if (req.method === 'POST' && path === '/v1/pair') {
        if (Number(req.headers['content-length']) > 4096) {
          req.resume();
          return send(413, { error: '请求过大。' });
        }
        if (!req.headers['content-type']?.startsWith('application/json')) {
          return send(415, { error: '需要 JSON。' });
        }
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req.iterator({ destroyOnReturn: false })) {
          const bytes = Buffer.from(chunk);
          size += bytes.length;
          if (size > 4096) {
            send(413, { error: '请求过大。' });
            req.resume();
            return;
          }
          chunks.push(bytes);
        }
        const input = claimSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        return send(201, pairing.claim(input));
      }
      const token = bearer(req);
      if (!token) return send(401, { error: '需要设备凭据。' });
      const match = /^\/v1\/pair\/([a-f0-9-]{36})$/.exec(path);
      if (req.method === 'GET' && match) {
        const result = pairing.poll(match[1]!, token);
        return result ? send(200, result) : send(401, { error: '请求已失效。' });
      }
      if (!pairing.authenticate(token)) return send(401, { error: '设备未授权。' });
      if (req.method === 'GET' && path === '/v1/status') {
        return send(200, {
          product: 'WeQ Remote',
          protocol: 1,
          scope: 'status:read',
          online: true,
        });
      }
      return send(404, { error: '接口不存在。' });
    } catch {
      return send(400, { error: '请求无效或邀请已失效。' });
    }
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 10_000;
  server.timeout = 10_000;
  server.maxConnections = 16;
  return server;
}
