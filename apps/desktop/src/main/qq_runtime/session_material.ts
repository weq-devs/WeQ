import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';
import type { NtHelperBinding } from '@weq/native';
import { setTimeout as delay } from 'node:timers/promises';

type OwnSessionReader = Pick<NtHelperBinding, 'getInitStatus' | 'scanSessionMaterial'>;
type OwnKernelReader = OwnSessionReader & Pick<NtHelperBinding, 'scanKeyFromDatabase'>;
type SessionIdentity = { uin: string; uid: string; guid: string };
type SessionTickets = { a2: string; d2: string; d2Key: string };

/** 必须在 QQ wrapper 载入之后调用，避免 nt_helper 的同名注册符号遮住桥。 */
export function loadOwnSessionReader(path: string): OwnKernelReader {
  if (!isAbsolute(path)) throw new Error('原生会话读取器路径无效');
  const nt = createRequire(import.meta.url)(path) as OwnKernelReader;
  if (nt.getInitStatus() !== 0 || typeof nt.scanSessionMaterial !== 'function')
    throw new Error('原生会话读取器不可用');
  return nt;
}

/** 无目标 PID 参数：托管宿主只能读取自身，不接受渲染层或 IPC 指定其他进程。 */
export async function readOwnSessionMaterial(nt: OwnSessionReader): Promise<SessionTickets> {
  const material = await nt.scanSessionMaterial(process.pid);
  const hex = (value: unknown, max: number): value is string =>
    typeof value === 'string' && value.length <= max && /^(?:[a-fA-F0-9]{2})+$/.test(value);
  if (
    !hex(material.a2, 16384) ||
    !hex(material.d2, 16384) ||
    !hex(material.d2Key, 32) ||
    material.d2Key.length !== 32
  ) {
    throw new Error('QQ 内核的当前登录票据尚未就绪');
  }
  return { a2: material.a2, d2: material.d2, d2Key: material.d2Key };
}

/** 自身扫描串行执行，身份失效后丢弃结果；只对未就绪的只读采集作有界重试。 */
export class OwnQQSessionCollector {
  private queue: Promise<void> = Promise.resolve();
  constructor(
    private readonly identify: () => SessionIdentity | null,
    private readonly read: () => Promise<SessionTickets>,
    private readonly publish: (
      result: SessionIdentity & { requestId: string; material: SessionTickets },
    ) => void,
    private readonly wait: () => Promise<unknown> = () => delay(750),
  ) {}

  collect(requestId: string): Promise<void> {
    const next = this.queue.then(() => this.collectInTurn(requestId));
    this.queue = next.catch(() => {});
    return next;
  }

  private async collectInTurn(requestId: string): Promise<void> {
    const identity = this.identify();
    if (!identity) return;
    const current = () => {
      const latest = this.identify();
      return (
        latest?.uin === identity.uin && latest.uid === identity.uid && latest.guid === identity.guid
      );
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!current()) return;
      try {
        const material = await this.read();
        if (current()) this.publish({ ...identity, requestId, material });
        return;
      } catch {
        if (attempt === 2) throw new Error('QQ 内核的当前登录票据尚未就绪，请重新连接');
        await this.wait();
      }
    }
  }
}
