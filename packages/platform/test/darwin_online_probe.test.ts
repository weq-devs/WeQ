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
    expect(await probe('/different/db')).toBeNull();
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
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toBeNull();
    expect(pg.kill).toHaveBeenCalledWith('SIGKILL');
    expect(await probe(path)).toBeNull();
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
        throw new Error('missing');
      })(path),
    ).toBeNull();
    expect(launch).not.toHaveBeenCalled();
    expect(await createQqOnlineProbe(launch, (x) => x)(path)).toBeNull();
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
    expect(await tooMuch).toBeNull();
    expect(large.kill).toHaveBeenCalledWith('SIGKILL');
  });
});
