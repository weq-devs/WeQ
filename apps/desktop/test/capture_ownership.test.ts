// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { CaptureOwnership } from '../src/main/capture_ownership';

function fixture() {
  let id = 0;
  return new CaptureOwnership(() => `synthetic-${++id}`);
}

describe('抓包会话归属', () => {
  it('迟到的旧启动不覆盖新会话，旧停止也不能释放新会话', async () => {
    const ownership = fixture();
    const old = ownership.begin('synthetic');
    const next = ownership.begin('synthetic');
    await ownership.start(
      next,
      42,
      async () => 'new',
      async () => {},
    );
    const start = vi.fn(async () => 'old'),
      dispose = vi.fn(async () => {});
    await expect(ownership.start(old, 42, start, dispose)).rejects.toThrow('失效');
    expect(start).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
    expect(await ownership.stop(42, old.id, dispose)).toBeNull();
    expect(dispose).not.toHaveBeenCalled();
    expect(await ownership.take(42, next.id, async () => ['new frame'])).toEqual(['new frame']);
    await ownership.stop(42, next.id, dispose);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('同 pid 的在途启动、回收和替换按顺序执行', async () => {
    const ownership = fixture(),
      events: string[] = [];
    const old = ownership.begin('synthetic');
    let finish!: () => void;
    const first = ownership.start(
      old,
      42,
      async () => {
        events.push('old-start');
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return 'old';
      },
      async () => {
        events.push('old-dispose');
      },
    );
    const rejected = expect(first).rejects.toThrow('替换');
    await vi.waitFor(() => expect(events).toEqual(['old-start']));
    const next = ownership.begin('synthetic');
    const second = ownership.start(
      next,
      42,
      async () => {
        events.push('new-start');
        return 'new';
      },
      async () => {},
    );
    finish();
    await rejected;
    expect(await second).toBe('new');
    expect(events).toEqual(['old-start', 'old-dispose', 'new-start']);
  });

  it('轮询期间换会话时丢弃旧轮询返回值，不泄露新归属的数据', async () => {
    const ownership = fixture();
    const old = ownership.begin('synthetic');
    await ownership.start(
      old,
      42,
      async () => {},
      async () => {},
    );
    let finish!: (frames: string[]) => void;
    const pending = ownership.take(
      42,
      old.id,
      () =>
        new Promise<string[]>((resolve) => {
          finish = resolve;
        }),
    );
    const rejected = expect(pending).rejects.toThrow('替换');
    const next = ownership.begin('synthetic');
    await ownership.start(
      next,
      42,
      async () => {},
      async () => {},
    );
    finish(['must not escape']);
    await rejected;
    const read = vi.fn(async () => []);
    await expect(ownership.take(42, old.id, read)).rejects.toThrow('替换');
    expect(read).not.toHaveBeenCalled();
  });

  it('启动失败和宿主重置都会清理资源，后续任务仍可执行', async () => {
    const ownership = fixture(),
      dispose = vi.fn(async () => {});
    const failed = ownership.begin('synthetic');
    await expect(
      ownership.start(
        failed,
        42,
        async () => {
          throw new Error('synthetic failure');
        },
        dispose,
      ),
    ).rejects.toThrow('synthetic failure');
    expect(dispose).toHaveBeenCalledOnce();
    const active = ownership.begin('synthetic');
    await ownership.start(active, 42, async () => {}, dispose);
    ownership.reset();
    await expect(ownership.take(42, active.id, async () => [])).rejects.toThrow('结束');
    expect(await ownership.stop(42, active.id, dispose)).toBeNull();
    expect(await ownership.take(42, undefined, async () => ['legacy'])).toEqual(['legacy']);
    await ownership.stop(42, undefined, dispose);
    expect(dispose).toHaveBeenCalledTimes(2);
  });
});
