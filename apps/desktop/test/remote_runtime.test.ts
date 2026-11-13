// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import type { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { tokenHash } from '../src/main/remote/pairing';
import { RemoteRuntime } from '../src/main/remote/runtime';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('远程服务的故障关闭', () => {
  it('恢复连接开关和模式逐项生效，配对与网络身份原样保留', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'weq-reset-remote-'));
    const claims = [
      {
        id: '11111111-1111-4111-8111-111111111111',
        name: '合成手机',
        tokenHash: 'a'.repeat(64),
        approvedAt: 1,
        lastSeenAt: null,
        scope: 'web:access',
      },
    ];
    const path = join(dir, 'devices.json');
    writeFileSync(
      path,
      JSON.stringify({
        enabled: true,
        mode: 'tailscale',
        tailscaleEnabled: true,
        networkIdentity: 'network-123',
        claims,
      }),
    );
    const runtime = new RemoteRuntime();
    runtime.configure({ helper: process.execPath, stateDir: dir });
    try {
      await runtime.restorePreferences(['remoteMode']);
      expect(runtime.preferences()).toEqual({ enabled: true, mode: 'lan', tailscaleEnabled: true });
      await runtime.restorePreferences(['remoteEnabled', 'tailscaleEnabled']);
      expect(runtime.preferences()).toEqual({
        enabled: false,
        mode: 'lan',
        tailscaleEnabled: false,
      });
      expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
        claims,
        networkIdentity: 'network-123',
      });
    } finally {
      runtime.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('启动期间关闭 Remote，不再创建 Web 入口或启动网络助手', async () => {
    const launch = vi.fn();
    const web = vi.fn();
    const runtime = new RemoteRuntime(launch as typeof spawn);
    const dir = mkdtempSync(join(tmpdir(), 'weq-cancel-runtime-'));
    runtime.configure({ helper: process.execPath, stateDir: dir, web });
    try {
      const starting = runtime.start();
      runtime.stop(true);
      await starting;
      expect(web).not.toHaveBeenCalled();
      expect(launch).not.toHaveBeenCalled();
      expect(runtime.status().enabled).toBe(false);
      await runtime.resume();
      expect(web).not.toHaveBeenCalled();
    } finally {
      runtime.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('共享页面准备失败时不启动网络助手，失败后仍可重试', async () => {
    const launch = vi.fn();
    const web = vi.fn(() => {
      throw new Error('Web 页面尚未构建');
    });
    const runtime = new RemoteRuntime(launch as typeof spawn);
    const dir = mkdtempSync(join(tmpdir(), 'weq-missing-web-'));
    runtime.configure({ helper: process.execPath, stateDir: dir, web });
    try {
      await expect(runtime.start()).rejects.toThrow('Web 页面尚未构建');
      await expect(runtime.start()).rejects.toThrow('Web 页面尚未构建');
      expect(web).toHaveBeenCalledTimes(2);
      expect(launch).not.toHaveBeenCalled();
      expect(runtime.status().enabled).toBe(false);
    } finally {
      runtime.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('WeQ 专用 Tailscale 独立启停，局域网入口与已配对设备不被重启', async () => {
    const children: ChildProcessWithoutNullStreams[] = [];
    const launch = vi.fn(() => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdin: new PassThrough(),
        exitCode: null,
        kill: vi.fn(function (this: EventEmitter) {
          this.emit('exit', 0);
          return true;
        }),
      }) as unknown as ChildProcessWithoutNullStreams;
      children.push(child);
      return child;
    });
    const runtime = new RemoteRuntime(launch as typeof spawn);
    const dir = mkdtempSync(join(tmpdir(), 'weq-dual-runtime-'));
    runtime.configure({ helper: process.execPath, stateDir: dir });
    const send = async (child: ChildProcessWithoutNullStreams, event: object) => {
      child.stdout.emit('data', Buffer.from(`${JSON.stringify(event)}\n`));
      await setImmediate();
    };
    try {
      await runtime.start();
      await send(children[0], {
        state: 'online',
        addresses: ['https://192.168.1.8:7691', 'https://100.64.0.99:7691'],
        fingerprint: 'f'.repeat(64),
      });
      expect(runtime.status().network.addresses).toEqual(['https://192.168.1.8:7691']);
      await runtime.setTailscaleEnabled(true);
      expect(launch).toHaveBeenCalledTimes(2);
      expect(children[0].kill).not.toHaveBeenCalled();
      await send(children[1], { state: 'online', address: 'http://100.64.0.10:7691' });
      expect(runtime.status().network.addresses).toEqual([
        'https://192.168.1.8:7691',
        'https://100.64.0.10:7692',
      ]);
      const multi = new URL((await runtime.invite()).pairingURL);
      expect(multi.searchParams.get('v')).toBe('4');
      expect(multi.searchParams.getAll('endpoint')).toEqual([
        'https://192.168.1.8:7691',
        'http://100.64.0.10:7691',
        'https://100.64.0.10:7692',
      ]);
      expect(
        new URL(
          (await runtime.invite({ authKey: `tskey-auth-${'k'.repeat(40)}` })).pairingURL,
        ).searchParams.get('v'),
      ).toBe('4');
      const lanInvite = await runtime.invite({ endpoint: 'https://192.168.1.8:7691' });
      const lanSecret = new URL(lanInvite.pairingURL).searchParams.get('invitation')!;
      await runtime.setTailscaleEnabled(false);
      expect(runtime.status().invitationExpiresAt).toBe(lanInvite.expiresAt);
      const lanClaim = runtime.pairing.claim({
        invitation: lanSecret,
        name: '局域网手机',
        tokenHash: tokenHash('d'.repeat(64)),
      });
      expect(runtime.status().pending.some((row) => row.id === lanClaim.id)).toBe(true);
      expect(children[1].kill).toHaveBeenCalledOnce();
      expect(children[0].kill).not.toHaveBeenCalled();
      expect(runtime.status().enabled).toBe(true);
      expect(runtime.status().network.addresses).toEqual(['https://192.168.1.8:7691']);
      await expect(runtime.invite({ authKey: `tskey-auth-${'k'.repeat(40)}` })).rejects.toThrow(
        'Tailscale',
      );
    } finally {
      runtime.stop();
      for (const child of children) {
        child.stdout.destroy();
        child.stderr.destroy();
        child.stdin.destroy();
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
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
    const tailscaleChild = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      kill: () => true,
    }) as unknown as ChildProcessWithoutNullStreams;
    let launches = 0;
    const launch = (() => (launches++ === 0 ? child : tailscaleChild)) as typeof spawn;
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
      tailscaleChild.stdout.emit(
        'data',
        Buffer.from(`${JSON.stringify({ state: 'online', address: 'http://100.64.0.10:7691' })}\n`),
      );
      await setImmediate();
      expect(runtime.status().network.state).toBe('online');
      const invite = await runtime.invite({
        authKey: `tskey-auth-${'j'.repeat(40)}`,
        singleUseConfirmed: true,
      });
      const pairingURL = new URL(invite.pairingURL);
      expect(pairingURL.protocol).toBe('weq-remote:');
      expect(pairingURL.searchParams.getAll('endpoint')).toContain('http://100.64.0.10:7691');
      expect(invite.qr).toMatch(/^data:image\/png;base64,/);
      const authKey = `tskey-auth-${'k'.repeat(40)}`;
      await expect(
        runtime.invite({ authKey: 'tskey-api-invalid', singleUseConfirmed: true }),
      ).rejects.toThrow();
      const bootstrap = await runtime.invite({ authKey, singleUseConfirmed: true });
      const bootstrapURL = new URL(bootstrap.pairingURL);
      expect(bootstrapURL.searchParams.get('v')).toBe('4');
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
      tailscaleChild.stdout.destroy();
      tailscaleChild.stderr.destroy();
      tailscaleChild.stdin.destroy();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
