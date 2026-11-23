import { createServer } from 'node:net';
import { nextOneBotPort } from '@weq/service/service-ports';
import type { ControlOneBotConfig } from '@weqbot/control';

function canListen(host: string, port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') resolve(false);
      else reject(error);
    });
    server.listen({ host, port, exclusive: true }, () => {
      server.close((error) => (error ? reject(error) : resolve(true)));
    });
  });
}

export async function suggestOneBotPort(
  configs: Readonly<Record<string, ControlOneBotConfig | null>>,
  kind: 'ws' | 'http',
  host: string,
): Promise<number> {
  const used = new Set<number>();
  for (const config of Object.values(configs)) {
    if (!config) continue;
    for (const row of [...config.networks.wsServers, ...config.networks.httpServers])
      used.add(row.port);
  }
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = nextOneBotPort(used, kind);
    if (await canListen(host, port)) return port;
    used.add(port);
  }
  throw new Error('暂时找不到可用的 OneBot 端口，请填写其他端口。');
}
