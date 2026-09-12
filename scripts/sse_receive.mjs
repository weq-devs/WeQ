// 示例：SSE 消息推送接收端 —— WeQ「设置 → SSE 推送」的推送目标。
//
// WeQ 把新消息 POST 到这个接收端（Bearer access_token 鉴权），本脚本把每个
// 事件打印到控制台，并实时广播给所有 SSE 订阅者（浏览器 EventSource 直接看）。
//
// 用法：
//   node scripts/sse_receive.mjs [--port 8899] [--token my-secret]
//
// 提供的接口：
//   POST /push         接收 WeQ 推送的 JSON（{ events: [...] } 或单个事件对象），
//                      校验通过后打印 + 广播。
//   GET  /sse          SSE 事件流（?access_token= 或 Authorization 头），
//                      把收到的 message / mass 事件实时转发。
//   GET  /             状态页：当前订阅数、收到事件数。
//
// 在 WeQ 设置 → SSE 推送 里填：
//   推送地址   http://127.0.0.1:8899/push
//   access_token  与 --token 一致（--token 留空则跳过校验）
//
// 浏览器订阅：http://127.0.0.1:8899/sse?access_token=my-secret

import { createServer } from 'node:http';

const args = parseArgs(process.argv.slice(2));
const PORT = args.port ?? 8899;
const TOKEN = args.token ?? ''; // 空 = 不校验

const sseClients = new Set();
let eventCount = 0;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

  if (url.pathname === '/') return handleStatus(req, res);
  if (url.pathname === '/sse') return handleSse(req, res, url);
  if (url.pathname === '/push') return handlePush(req, res, url);

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[sse-receive] 监听 http://0.0.0.0:${PORT}`);
  console.log(`[sse-receive] WeQ 推送地址：http://127.0.0.1:${PORT}/push`);
  console.log(`[sse-receive] access_token：${TOKEN || '(未设置，不校验)'}`);
  console.log(
    `[sse-receive] 浏览器订阅：http://127.0.0.1:${PORT}/sse?access_token=${TOKEN || '<token>'}`,
  );
  console.log('[sse-receive] 等待 WeQ 推送… Ctrl+C 停止');
});

// ---- 接口 ----

function handleStatus(_req, res) {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(
    `SSE 接收端运行中\n端口：${PORT}\nSSE 订阅数：${sseClients.size}\n已接收事件：${eventCount}\n`,
  );
}

function handleSse(req, res, url) {
  if (!authorized(req, url)) {
    res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('unauthorized: 需要 access_token');
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  const client = { req, res, id: ++eventCount };
  sseClients.add(client);
  console.log(`[sse] 订阅者接入（当前 ${sseClients.size} 个）`);
  // 心跳，防止代理断连
  const heartbeat = setInterval(() => {
    if (res.writableEnded) return;
    res.write(': ping\n\n');
  }, 15000);
  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(client);
    console.log(`[sse] 订阅者断开（当前 ${sseClients.size} 个）`);
  });
}

async function handlePush(req, res, url) {
  if (!authorized(req, url)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
    return;
  }
  let body = '';
  for await (const chunk of req) body += chunk;

  let payload;
  try {
    payload = JSON.parse(body || '{}');
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'invalid json' }));
    return;
  }

  const events = Array.isArray(payload?.events) ? payload.events : [payload];
  eventCount += events.length;
  for (const event of events) printEvent(event);
  broadcast(events);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, received: events.length }));
}

// ---- 工具 ----

function authorized(req, url) {
  if (!TOKEN) return true;
  if (url.searchParams.get('access_token') === TOKEN) return true;
  const header = req.headers.authorization ?? '';
  return header === `Bearer ${TOKEN}`;
}

function broadcast(events) {
  const lines = [];
  for (const event of events) {
    const name = event?.type === 'mass' ? 'mass' : 'message';
    lines.push(`event: ${name}\ndata: ${JSON.stringify(event)}\n`);
  }
  const frame = lines.join('\n');
  for (const client of sseClients) {
    if (!client.res.writableEnded) client.res.write(frame);
  }
}

function printEvent(event) {
  if (!event || typeof event !== 'object') return;
  console.log(JSON.stringify(event, null, 2));
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--port') out.port = Number(value);
    if (key === '--token') out.token = value;
  }
  return out;
}
