// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import type { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { tokenHash } from '../src/main/remote/pairing';
import { RemoteRuntime } from '../src/main/remote/runtime';

describe('远程服务的故障关闭', () => {
  it('没有辅助程序时拒绝启动，不生成邀请或假报在线', async () => {
    const runtime = new RemoteRuntime();
    expect(runtime.status().available).toBe(false);
    await expect(runtime.start()).rejects.toThrow('尚未安装');
    await expect(runtime.invite()).rejects.toThrow('请先完成网络登录');
    expect(runtime.status().enabled).toBe(false);
    expect(runtime.status().network.state).toBe('offline');
    runtime.stop();
    runtime.stop();
    expect(runtime.status().devices).toEqual([]);
  });

  it('辅助程序异常退出会关闭监听并清空授权', async () => {
    const events = new EventEmitter();
    const child = Object.assign(events, {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      kill: () => true,
    }) as unknown as ChildProcessWithoutNullStreams;
    const launch = (() => child) as typeof spawn;
    const runtime = new RemoteRuntime(launch);
    runtime.configure({ helper: process.execPath, stateDir: '/unused-test-state' });
    try {
      await runtime.start();
      expect(runtime.status().network.state).toBe('starting');
      child.stdout.emit(
        'data',
        Buffer.from(`${JSON.stringify({ state: 'online', address: 'http://100.64.0.10:7691' })}\n`),
      );
      await setImmediate();
      expect(runtime.status().network.state).toBe('online');
      const invite = await runtime.invite();
      const pairingURL = new URL(invite.pairingURL);
      expect(pairingURL.protocol).toBe('weq-remote:');
      expect(pairingURL.searchParams.get('endpoint')).toBe('http://100.64.0.10:7691');
      expect(invite.qr).toMatch(/^data:image\/png;base64,/);
      const request = runtime.pairing.claim({
        invitation: pairingURL.searchParams.get('invitation')!,
        name: '手机',
        tokenHash: tokenHash('a'.repeat(64)),
      });
      runtime.pairing.decide(request.id, true);
      expect(runtime.status().devices).toHaveLength(1);
      child.emit('exit', 1);
      expect(runtime.status().enabled).toBe(false);
      expect(runtime.status().network.state).toBe('error');
      expect(runtime.status().devices).toEqual([]);
    } finally {
      runtime.stop();
      child.stdout.destroy();
      child.stderr.destroy();
      child.stdin.destroy();
    }
  });
});
