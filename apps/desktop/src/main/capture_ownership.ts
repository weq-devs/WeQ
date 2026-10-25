import { randomUUID } from 'node:crypto';

export interface CaptureRequest {
  uin: string;
  id: string;
}

/** 同 pid 的替换/停止串行；长轮询只检查身份，不阻塞停止。 */
export class CaptureOwnership {
  private readonly requests = new Map<string, CaptureRequest>();
  private readonly sessions = new Map<number, CaptureRequest>();
  private readonly queues = new Map<number, Promise<void>>();

  constructor(private readonly makeId: () => string = randomUUID) {}

  begin(uin: string): CaptureRequest {
    const request = { uin, id: this.makeId() };
    this.requests.set(uin, request);
    return request;
  }

  cancel(request: CaptureRequest): void {
    if (this.requests.get(request.uin)?.id === request.id) this.requests.delete(request.uin);
  }

  reset(): void {
    this.requests.clear();
    this.sessions.clear();
  }

  owns(pid: number, id: string): boolean {
    return this.sessions.get(pid)?.id === id;
  }

  private current(request: CaptureRequest): boolean {
    return this.requests.get(request.uin)?.id === request.id;
  }

  private exclusive<T>(pid: number, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(pid) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(pid, settled);
    void settled.then(() => {
      if (this.queues.get(pid) === settled) this.queues.delete(pid);
    });
    return result;
  }

  start<T>(
    request: CaptureRequest,
    pid: number,
    start: () => Promise<T>,
    dispose: () => Promise<unknown>,
  ): Promise<T> {
    return this.exclusive(pid, async () => {
      if (!this.current(request)) throw new Error('抓包请求已失效，请重新开始');
      const previous = this.sessions.get(pid);
      if (previous && previous.id !== request.id) this.cancel(previous);
      this.sessions.set(pid, request);
      try {
        const value = await start();
        if (!this.current(request)) throw new Error('抓包请求已被新的请求替换');
        return value;
      } catch (error) {
        this.sessions.delete(pid);
        this.cancel(request);
        await dispose().catch(() => undefined);
        throw error;
      }
    });
  }

  async take<T>(pid: number, id: string | undefined, read: () => Promise<T>): Promise<T> {
    const check = () => {
      if (id && this.sessions.get(pid)?.id !== id) throw new Error('抓包会话已结束或被替换');
    };
    check();
    const result = await read();
    check();
    return result;
  }

  stop<T>(pid: number, id: string | undefined, stop: () => Promise<T>): Promise<T | null> {
    return this.exclusive(pid, async () => {
      const session = this.sessions.get(pid);
      if (id && session?.id !== id) return null;
      this.sessions.delete(pid);
      if (session) this.cancel(session);
      return stop();
    });
  }
}
