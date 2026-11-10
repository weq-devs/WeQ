export const DEFAULT_SERVICE_PORTS = {
  web: 7690,
  mcp: 48765,
  'onebot-ws': 48800,
  'onebot-http': 48840,
  'weq-assistant': 27182,
} as const;

type Service = keyof typeof DEFAULT_SERVICE_PORTS;

const RESERVED_PORTS: ReadonlyArray<readonly [Service | 'remote', number, number]> = [
  ['web', DEFAULT_SERVICE_PORTS.web, 7701],
  ['remote', 7691, 7692],
  ['mcp', DEFAULT_SERVICE_PORTS.mcp, DEFAULT_SERVICE_PORTS.mcp + 19],
  ['onebot-ws', DEFAULT_SERVICE_PORTS['onebot-ws'], DEFAULT_SERVICE_PORTS['onebot-ws'] + 19],
  ['onebot-http', DEFAULT_SERVICE_PORTS['onebot-http'], DEFAULT_SERVICE_PORTS['onebot-http'] + 19],
  [
    'weq-assistant',
    DEFAULT_SERVICE_PORTS['weq-assistant'],
    DEFAULT_SERVICE_PORTS['weq-assistant'] + 19,
  ],
];

function reservedForOtherService(service: Service, port: number): boolean {
  return RESERVED_PORTS.some(
    ([owner, start, end]) => owner !== service && port >= start && port <= end,
  );
}

/** 显式指定的端口优先；仅自动回退避开其他服务的预留范围及已配置端口。 */
export function servicePortCandidates(
  service: Service,
  requested: number,
  attempts: number,
  configuredPorts: ReadonlySet<number> = new Set(),
): number[] {
  if (!Number.isInteger(requested) || requested < 0 || requested > 65535)
    throw new Error('服务端口无效');
  if (requested === 0) return [0];
  const ports: number[] = [];
  for (let port = requested; port <= 65535 && ports.length < attempts; port += 1) {
    if (port !== requested && (reservedForOtherService(service, port) || configuredPorts.has(port)))
      continue;
    ports.push(port);
  }
  return ports;
}

export function nextOneBotPort(used: ReadonlySet<number>, type: 'ws' | 'http'): number {
  const service = type === 'ws' ? 'onebot-ws' : 'onebot-http';
  for (let port: number = DEFAULT_SERVICE_PORTS[service]; port <= 65535; port += 1) {
    if (!used.has(port) && !reservedForOtherService(service, port)) return port;
  }
  throw new Error('没有可用的 OneBot 配置端口');
}
