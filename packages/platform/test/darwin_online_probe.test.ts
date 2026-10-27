import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQqOnlineProbe, parseQqDbHolders } from '../src/darwin/online_probe';

const path = '/fixture/账号/nt_msg.db';
function child() {
  const proc = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
  return proc as typeof proc & ChildProcess;
}
afterEach(() => vi.useRealTimers());
describe('bounded macOS account online probe', () => {
  it('requires the exact QQ process and database path in NUL-delimited output', () => {
    expect(parseQqDbHolders(`p123\0cQQ\0\nn${path}\0\n`, path)).toBe(123);
    for (const output of [
      `p123\0cWeQ\0\nn${path}\0`,
      `p123\0cQQ Helper\0\nn${path}\0`,
      `p123\0cQQ\0\nn${path}-wal\0`,
      `p123\0cQQ\0\nn${path} (deleted)\0`,
      `p123\0\nn${path}\0`,
      `p123\0cQQ\0\nn${path}\0\np456\0cQQ\0\nn${path}\0`,
    ])
      expect(parseQqDbHolders(output, path)).toBeNull();
  });
  it('restricts lsof to real QQ candidates and shares one in-flight probe', async () => {
    const pg = child(),
      files = child();
    const launch = vi.fn().mockReturnValueOnce(pg).mockReturnValueOnce(files);
    const probe = createQqOnlineProbe(launch, (x) => x);
    const result = probe(path);
    expect(probe(path)).toBe(result);
    pg.stdout.write('123\n456\n');
    pg.emit('close', 0);
    expect(launch.mock.calls[0]).toEqual(['/usr/bin/pgrep', ['-x', 'QQ']]);
    expect(launch.mock.calls[1]).toEqual([
      '/usr/sbin/lsof',
      ['-nP', '-a', '-p', '123,456', '-F0pcn', '--', path],
    ]);
    const output = Buffer.from(`p123\0cQQ\0\nn${path}\0\n`);
    for (const byte of output) files.stdout.write(Buffer.from([byte]));
    files.emit('close', 0);
    expect(await result).toBe(123);
  });
  it('returns promptly on timeout without launching more stuck children', async () => {
    vi.useFakeTimers();
    const pg = child();
    const launch = vi.fn(() => pg);
    const probe = createQqOnlineProbe(launch, (x) => x, 100);
    const result = probe(path);
    const timedOut = expect(result).rejects.toThrow('超时');
    await vi.advanceTimersByTimeAsync(100);
    await timedOut;
    expect(pg.kill).toHaveBeenCalledWith('SIGKILL');
    await expect(probe(path)).rejects.toThrow('尚未退出');
    expect(launch).toHaveBeenCalledTimes(1);
    pg.emit('close', null);
    const next = probe(path);
    expect(launch).toHaveBeenCalledTimes(2);
    pg.emit('close', 1);
    expect(await next).toBeNull();
  });
  it('handles missing files, absent QQ, spawn failure and excess output without guessing', async () => {
    const launch = vi.fn(() => {
      throw new Error('unavailable');
    });
    expect(
      await createQqOnlineProbe(launch, () => {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      })(path),
    ).toBeNull();
    expect(launch).not.toHaveBeenCalled();
    await expect(
      createQqOnlineProbe(launch, () => {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      })(path),
    ).rejects.toThrow('路径');
    await expect(createQqOnlineProbe(launch, (x) => x)(path)).rejects.toThrow('启动');
    const pg = child();
    const noQq = createQqOnlineProbe(
      () => pg,
      (x) => x,
    )(path);
    pg.emit('close', 1);
    expect(await noQq).toBeNull();
    const large = child();
    const tooMuch = createQqOnlineProbe(
      () => large,
      (x) => x,
    )(path);
    large.stdout.write(Buffer.alloc(300000));
    large.emit('close', null);
    await expect(tooMuch).rejects.toThrow('输出');
    expect(large.kill).toHaveBeenCalledWith('SIGKILL');
  });
  it('不同账号并发探测互不冒充离线，同时限制未退出的子进程数量', async () => {
    const children = Array.from({ length: 8 }, child);
    const launch = vi.fn();
    for (const proc of children) launch.mockReturnValueOnce(proc);
    const probe = createQqOnlineProbe(launch, (x) => x);
    const results = children.map((_, i) => probe(`/fixture/${i}/nt_msg.db`));
    await expect(probe('/fixture/overflow/nt_msg.db')).rejects.toThrow('繁忙');
    expect(launch).toHaveBeenCalledTimes(children.length);
    for (const proc of children) proc.emit('close', 1);
    expect(await Promise.all(results)).toEqual(children.map(() => null));
  });
  it('并发账号各自匹配自己的数据库，不混用同一个 QQ 进程的结果', async () => {
    const pg1 = child(),
      pg2 = child(),
      files1 = child(),
      files2 = child();
    const launch = vi
      .fn()
      .mockReturnValueOnce(pg1)
      .mockReturnValueOnce(pg2)
      .mockReturnValueOnce(files1)
      .mockReturnValueOnce(files2);
    const probe = createQqOnlineProbe(launch, (x) => x);
    const first = probe(path);
    const otherPath = '/fixture/other/nt_msg.db';
    const second = probe(otherPath);
    for (const proc of [pg1, pg2]) {
      proc.stdout.write('123\n');
      proc.emit('close', 0);
    }
    files1.stdout.write(`p123\0cQQ\0\nn${path}\0\n`);
    files2.stdout.write(`p123\0cQQ\0\nn${path}\0\n`);
    files2.emit('close', 0);
    files1.emit('close', 0);
    expect(await first).toBe(123);
    expect(await second).toBeNull();
  });
  it('退出码 1 带诊断信息时仍视为探测失败', async () => {
    const proc = child();
    const result = createQqOnlineProbe(
      () => proc,
      (x) => x,
    )(path);
    proc.stderr.write('permission denied');
    proc.emit('close', 1);
    await expect(result).rejects.toThrow('失败');
  });
  it('lsof 运行错误不等同于正常查无持有者', async () => {
    const pg = child(),
      files = child();
    const probe = createQqOnlineProbe(
      vi.fn().mockReturnValueOnce(pg).mockReturnValueOnce(files),
      (x) => x,
    );
    const result = probe(path);
    pg.stdout.write('123\n');
    pg.emit('close', 0);
    files.emit('close', 2);
    await expect(result).rejects.toThrow('失败');
  });
});
