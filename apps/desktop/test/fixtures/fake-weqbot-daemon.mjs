/**
 * 测试用的假 weqbot daemon：只实现控制通道的服务端，业务方法照最小语义。
 *
 * 放在 `apps/desktop/test/fixtures/` 而不是临时目录，是因为它要能解析
 * `@weqbot/control` —— 模块解析是从**脚本所在地**往上找 `node_modules` 的，
 * 临时目录里找不到 workspace 链接。
 *
 * 参数与真的 daemon 一致：`--account <uin> --socket <path>`。
 */

import { listenControlSocket, controlFailure, controlSuccess } from '@weqbot/control';

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const socket = arg('--socket');
const uin = arg('--account');

let onebot = null;
let opened = 'none';
let finish;
const done = new Promise((resolve) => {
  finish = resolve;
});

const status = () => ({
  uin,
  state: opened === 'none' ? 'idle' : 'online',
  sessionId: opened === 'none' ? null : 1,
  lastEventAt: null,
  device: null,
});

const server = await listenControlSocket({
  path: socket,
  onPeer(peer) {
    peer.onRequest(async (envelope) => {
      const reply = (result) => peer.send(controlSuccess(envelope.id, result));
      try {
        switch (envelope.method) {
          case 'ping':
            return reply({ pid: process.pid, ts: Date.now() });
          case 'status':
            return reply(status());
          case 'login':
          case 'attach':
            if (opened !== 'none') {
              throw new Error('ALREADY_ONLINE');
            }
            opened = envelope.method;
            return reply(status());
          case 'onebot.get':
            return reply({ configured: onebot !== null, config: onebot, listeners: [] });
          case 'onebot.set':
            onebot = envelope.params?.config ?? null;
            return reply({ configured: onebot !== null, config: onebot, listeners: [] });
          case 'shutdown':
            peer.send(controlSuccess(envelope.id, null));
            await server.close();
            finish(0);
            return;
          default:
            return peer.send(
              controlFailure(envelope.id, {
                code: 'CONTROL_PROTOCOL_ERROR',
                message: `未知方法 ${envelope.method}`,
              }),
            );
        }
      } catch (cause) {
        peer.send(
          controlFailure(envelope.id, {
            code: 'UNKNOWN',
            message: cause instanceof Error ? cause.message : String(cause),
          }),
        );
      }
    });
  },
});

process.stderr.write(`fake daemon ready ${socket}\n`);
await done;
