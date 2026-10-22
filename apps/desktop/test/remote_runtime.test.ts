// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import type { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { tokenHash } from '../src/main/remote/pairing';
import { RemoteRuntime } from '../src/main/remote/runtime';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

  it('辅助程序异常退出会关闭监听，但保留长期设备授权', async () => {
    const events = new EventEmitter();
    const child = Object.assign(events, {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      kill: () => true,
    }) as unknown as ChildProcessWithoutNullStreams;
    const launch = (() => child) as typeof spawn;
    const runtime = new RemoteRuntime(launch);
    const dir = mkdtempSync(join(tmpdir(), 'weq-runtime-'));
    runtime.configure({ helper: process.execPath, stateDir: dir });
    await runtime.setMode('tailscale');
    try {
      await runtime.start();
      expect(runtime.status().network.state).toBe('starting');
      child.stdout.emit(
        'data',
        Buffer.from(
          `${JSON.stringify({ state: 'online', address: 'http://100.64.0.10:7691', addresses: ['https://192.168.1.8:7691', 'https://100.64.0.10:7692'], fingerprint: 'f'.repeat(64) })}\n`,
        ),
      );
      await setImmediate();
      expect(runtime.status().network.state).toBe('online');
      const invite = await runtime.invite({
        authKey: `tskey-auth-${'j'.repeat(40)}`,
        singleUseConfirmed: true,
      });
      const pairingURL = new URL(invite.pairingURL);
      expect(pairingURL.protocol).toBe('weq-remote:');
      expect(pairingURL.searchParams.get('endpoint')).toBe('http://100.64.0.10:7691');
      expect(invite.qr).toMatch(/^data:image\/png;base64,/);
      const authKey = `tskey-auth-${'k'.repeat(40)}`;
      await expect(
        runtime.invite({ authKey: 'tskey-api-invalid', singleUseConfirmed: true }),
      ).rejects.toThrow();
      const bootstrap = await runtime.invite({ authKey, singleUseConfirmed: true });
      const bootstrapURL = new URL(bootstrap.pairingURL);
      expect(bootstrapURL.searchParams.get('v')).toBe('2');
      expect(bootstrapURL.searchParams.get('authKey')).toBe(authKey);
      expect(bootstrapURL.searchParams.get('expiresAt')).toBe(String(bootstrap.expiresAt));
      expect(JSON.stringify(runtime.status())).not.toContain(authKey);
      expect(() =>
        runtime.pairing.claim({
          invitation: pairingURL.searchParams.get('invitation')!,
          name: '旧邀请',
          tokenHash: tokenHash('b'.repeat(64)),
        }),
      ).toThrow();
      const request = runtime.pairing.claim({
        invitation: bootstrapURL.searchParams.get('invitation')!,
        name: '手机',
        tokenHash: tokenHash('a'.repeat(64)),
        scope: 'web:access',
      });
      runtime.pairing.decide(request.id, true);
      expect(runtime.status().devices).toHaveLength(1);
      const disconnected = vi.fn();
      runtime.pairing.watchWeb('a'.repeat(64), disconnected);
      await runtime.setMode('existing');
      expect(disconnected).not.toHaveBeenCalled();
      const direct = new URL(
        (await runtime.invite({ endpoint: 'https://100.64.0.10:7692' })).pairingURL,
      );
      expect(direct.searchParams.get('v')).toBe('3');
      expect(direct.searchParams.get('fingerprint')).toBe('f'.repeat(64));
      expect(direct.searchParams.has('authKey')).toBe(false);
      child.emit('exit', 1);
      expect(runtime.status().enabled).toBe(false);
      expect(runtime.status().network.state).toBe('error');
      expect(runtime.status().devices).toHaveLength(1);
    } finally {
      runtime.stop();
      child.stdout.destroy();
      child.stderr.destroy();
      child.stdin.destroy();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
