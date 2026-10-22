import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

test('独立手机仓库通过稳定夹具契约完成实际桌面配对、Web 和撤销', { timeout: 45_000 }, async () => {
  const mobile = process.env.WEQ_REMOTE_CLIENT_REPO;
  const root = fileURLToPath(new URL('..', import.meta.url));
  const command = mobile ? 'python3' : 'pnpm';
  const args = mobile
    ? [resolve(mobile, 'scripts/desktop_fixture.py'), '--desktop-repo', root]
    : ['exec', 'tsx', 'scripts/remote-integration-server.ts'];
  const child = spawn(command, args, {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      WEQ_REMOTE_TEST_PORT: '0',
      WEQ_REMOTE_LAN_TEST: '0',
      WEQ_REMOTE_TEST_CONFIG: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  let output = '';
  let errors = '';
  child.stderr.on('data', (chunk) => {
    errors = (errors + chunk).slice(-8192);
  });
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error(`fixture timeout: ${errors}`)), 30_000);
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(Error(`fixture exited ${code}: ${errors}`));
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.stdout.on('data', (chunk) => {
        output = (output + chunk).slice(-8192);
        for (const line of output.split('\n')) {
          try {
            const event = JSON.parse(line);
            if (event.event === 'remote-fixture-ready') {
              clearTimeout(timer);
              resolve(event.port);
            }
          } catch {}
        }
      });
    });
    const base = `http://127.0.0.1:${port}`;
    const contract = await (await fetch(`${base}/test/contract`)).json();
    assert.deepEqual(contract, { fixture: 1, protocol: 1, invitationVersions: [1, 2, 3] });
    assert.equal((await fetch(`${base}/v1/status`)).status, 401);
    const { url } = await (await fetch(`${base}/test/invitation`)).json();
    const invitation = new URL(url).searchParams.get('invitation');
    const token = randomBytes(32).toString('hex');
    const claimResponse = await fetch(`${base}/v1/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        invitation,
        name: 'synthetic split test',
        tokenHash: createHash('sha256').update(token).digest('hex'),
        scope: 'web:access',
      }),
    });
    assert.equal(claimResponse.status, 201);
    const claim = await claimResponse.json();
    const headers = { Authorization: `Bearer ${token}` };
    let approved = false;
    for (let i = 0; i < 20; i++) {
      const state = await (await fetch(`${base}/v1/pair/${claim.id}`, { headers })).json();
      if (state.approved) {
        approved = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(approved, true);
    assert.equal((await fetch(`${base}/v1/status`, { headers })).status, 200);
    assert.match(await (await fetch(base, { headers })).text(), /Web 容器联通测试/);
    assert.equal((await fetch(`${base}/trpc/probe`, { headers })).status, 200);
    await fetch(`${base}/test/revoke`, { method: 'POST' });
    assert.equal((await fetch(`${base}/v1/status`, { headers })).status, 401);
    assert.equal((await fetch(base, { headers })).status, 403);
  } finally {
    if (child.exitCode === null) {
      const exited = once(child, 'exit');
      const stop = (signal) => {
        try {
          if (process.platform === 'win32') child.kill(signal);
          else process.kill(-child.pid, signal);
        } catch (error) {
          if (error.code !== 'ESRCH') throw error;
        }
      };
      stop('SIGTERM');
      const timer = setTimeout(() => stop('SIGKILL'), 5000);
      await exited;
      clearTimeout(timer);
    }
  }
});
