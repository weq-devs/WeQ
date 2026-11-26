// @vitest-environment node
import http from 'node:http';
import { initTRPC } from '@trpc/server';
import { createTRPCUntypedClient, httpLink } from '@trpc/client';
import superjson from 'superjson';
import { z as z4 } from 'zod';
import { z } from 'zod/v3';
import { afterEach, expect, it } from 'vitest';
import { createTrpcHandler } from '../src/main/web/trpc_adapter';
const servers: http.Server[] = [];

it('WeQ 兼容 schema 和 MCP SDK 使用的 schema 都先检查数组长度', async () => {
  let visits = 0;
  const mark = () => {
    visits += 1;
    return true;
  };
  for (const schema of [
    z.array(z.string().refine(mark)).max(1),
    z4.array(z4.string().refine(mark)).max(1),
  ]) {
    expect(await schema.safeParseAsync(['a', 'b'])).toMatchObject({
      success: false,
      error: { issues: [{ code: 'too_big' }] },
    });
  }
  expect(visits).toBe(0);
});

it('WeQ 数组遇到首个无效值就停止，合法数组仍逐项转换', async () => {
  const item = z
    .string()
    .min(2)
    .transform((value) => value.trim());
  const array = z.array(item);
  expect(array.safeParse([' abc ', 'x', 'y'])).toMatchObject({
    success: false,
    error: { issues: [{ path: [1] }] },
  });
  expect(await array.safeParseAsync([' abc ', 'x', 'y'])).toMatchObject({
    success: false,
    error: { issues: [{ path: [1] }] },
  });
  expect(array.parse([' abc ', ' def '])).toEqual(['abc', 'def']);
  await expect(array.parseAsync([' abc ', ' def '])).resolves.toEqual(['abc', 'def']);
});

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
async function fixture(transformed = false) {
  const t = initTRPC.create({ transformer: transformed ? superjson : undefined });
  const router = t.router({
    size: t.procedure.input(z.string()).mutation(({ input }) => input.length),
  });
  const server = http.createServer(createTrpcHandler(router));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing listener');
  return `http://127.0.0.1:${address.port}/trpc/size`;
}
it('真实 SuperJSON 客户端能解码超限回执，不退化为转换错误', async () => {
  const url = await fixture(true);
  const client = createTRPCUntypedClient({
    transformer: superjson,
    links: [httpLink({ url: url.slice(0, -'/size'.length) })],
  });
  await expect(client.mutation('size', 'a'.repeat(17 * 1024 * 1024))).rejects.toMatchObject({
    data: { code: 'PAYLOAD_TOO_LARGE', httpStatus: 413 },
  });
});
it('现有 14 MiB 图片输入仍可通过，超限正文在业务解析前拒绝', async () => {
  const url = await fixture();
  const valid = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify('a'.repeat(14 * 1024 * 1024)),
  });
  expect(valid.status).toBe(200);
  expect(await valid.json()).toMatchObject({ result: { data: 14 * 1024 * 1024 } });
  const excessive = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify('a'.repeat(17 * 1024 * 1024)),
  });
  expect(excessive.status).toBe(413);
  await excessive.body?.cancel();
});
it('后台解析返回无效大正文错误，并继续为小请求与合法大请求服务', async () => {
  const url = await fixture();
  const send = (body: string) =>
    fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  const body = '早🌙'.repeat(130_000);
  const [invalid, small, valid] = await Promise.all([
    send(`"${body}`),
    send('"ready"'),
    send(JSON.stringify(body)),
  ]);
  expect(invalid.status).toBe(400);
  expect(await small.json()).toMatchObject({ result: { data: 5 } });
  expect(await valid.json()).toMatchObject({ result: { data: body.length } });
});
it('chunked 超限立即返回，不等待发送方结束；按字节而非字符计数', async () => {
  const url = await fixture();
  const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
    const req = http.request(
      url,
      { method: 'POST', headers: { 'content-type': 'application/json' } },
      resolve,
    );
    req.on('error', reject);
    req.write(`"${'汉'.repeat(6 * 1024 * 1024)}`);
  });
  expect(response.statusCode).toBe(413);
  response.resume();
});
