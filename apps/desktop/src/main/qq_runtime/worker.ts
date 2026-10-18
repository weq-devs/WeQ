import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  loadQQKernel,
  QQKernelHost,
  validateQQKernelOptions,
  qqKernelErrorText,
} from './kernel_host';
import type { QQKernelEvent } from './kernel_protocol';
import {
  loadOwnSessionReader,
  readOwnSessionMaterial,
  OwnQQSessionCollector,
} from './session_material';

let host: QQKernelHost | null = null;
let booting = false;
let instanceId = '';
let stopping: Promise<void> | null = null;
let collector: OwnQQSessionCollector | null = null;
let sessionReader: ReturnType<typeof loadOwnSessionReader> | null = null;

function send(event: QQKernelEvent): void {
  if (process.connected) process.send?.(event, () => {});
}
function stop(code = 0): Promise<void> {
  stopping ??= (async () => {
    await host?.stop();
    if (process.connected) process.disconnect();
    process.exit(code);
  })();
  return stopping;
}

process.on('message', (value: unknown) => {
  void (async () => {
    if (!value || typeof value !== 'object') return;
    const command = value as Record<string, unknown>;
    if (command.type === 'boot') {
      if (host || booting) return;
      booting = true;
      const options = validateQQKernelOptions(command.options);
      instanceId = options.instanceId;
      const api = loadQQKernel(
        options.wrapperPath,
        join(dirname(fileURLToPath(import.meta.url)), 'qqKernelRegistration.node'),
      );
      host = new QQKernelHost(api, options, send);
      const ntHelperPath = options.ntHelperPath;
      if (ntHelperPath)
        collector = new OwnQQSessionCollector(
          () => (stopping ? null : (host?.sessionForTransport() ?? null)),
          async () => {
            sessionReader ??= loadOwnSessionReader(ntHelperPath);
            return readOwnSessionMaterial(sessionReader);
          },
          (result) => send({ type: 'session-material', instanceId, pid: process.pid, ...result }),
        );
      await host.initialize();
      booting = false;
      return;
    }
    if (
      !host ||
      command.instanceId !== host.options.instanceId ||
      command.nonce !== host.options.nonce
    )
      return;
    if (command.type === 'stop') await stop();
    else if (command.type === 'login')
      await host.startLogin(typeof command.uin === 'string' ? command.uin : undefined);
    else if (command.type === 'refresh-qr') host.refreshQr();
    else if (command.type === 'health') host.health();
    else if (
      command.type === 'collect-session' &&
      typeof command.requestId === 'string' &&
      command.requestId.length <= 128
    ) {
      const requestId = command.requestId;
      await collector
        ?.collect(requestId)
        .catch(() =>
          send({ type: 'session-material-error', requestId, instanceId, pid: process.pid }),
        );
    }
  })().catch((error: unknown) => {
    send({
      type: 'error',
      instanceId,
      pid: process.pid,
      code: 'worker-command',
      message: qqKernelErrorText(error),
      retryable: false,
    });
    if (booting) void stop(1);
  });
});
process.on('disconnect', () => {
  void stop();
});
process.on('SIGTERM', () => {
  void stop();
});
