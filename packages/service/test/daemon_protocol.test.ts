/**
 * daemon 管道协议层的离线单测 —— 与 Rust 侧 `packages/daemon/src/protocol.rs`
 * 的分帧格式对齐：4 字节小端长度 + JSON（UTF-8），单帧上限 1 MiB。
 *
 * 重点：坏输入不炸（对端按不可信处理，`parseDaemonResponse` 永远回一帧）、
 * 半帧返回 null（调用方继续等数据）、超限显式抛错（调用方问题）。
 */

import { describe, expect, it } from 'vitest';
import {
  DAEMON_MAX_FRAME,
  DAEMON_PIPE_NAME,
  decodeDaemonFrame,
  daemonPipePath,
  encodeDaemonFrame,
  parseDaemonResponse,
  type DaemonResponse,
} from '../src/daemon/protocol';

/** 手工按「4 字节小端长度 + JSON」封一帧响应（encodeDaemonFrame 只收请求）。 */
function encodeResponse(res: DaemonResponse): Buffer {
  const payload = Buffer.from(JSON.stringify(res), 'utf-8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(payload.byteLength, 0);
  return Buffer.concat([head, payload]);
}

describe('daemonPipePath', () => {
  it('unix 下落到 tmpdir 里的 .sock', () => {
    if (process.platform === 'win32') return; // 仅 CI/linux 语义
    expect(daemonPipePath()).toMatch(/weq-daemon\.sock$/);
  });

  it('自定义管道名透传', () => {
    expect(daemonPipePath('custom-pipe')).toContain('custom-pipe');
  });
});

describe('parseDaemonResponse', () => {
  it('合法响应原样透传', () => {
    const pong: DaemonResponse = { res: 'pong', version: '1.0.0', http_running: false };
    expect(parseDaemonResponse(JSON.stringify(pong))).toEqual(pong);
  });

  it.each([
    ['非 JSON', 'not json at all'],
    ['JSON 但无 res', '{"hello":1}'],
    ['null 字面量', 'null'],
    ['数字', '42'],
    ['空串', ''],
  ])('%s → error 帧（不抛）', (_label, junk) => {
    const res = parseDaemonResponse(junk);
    expect(res.res).toBe('error');
    expect(res.message).toContain('malformed daemon response');
  });

  it('error 帧信息截断到 200 字符以内', () => {
    const res = parseDaemonResponse('x'.repeat(5000));
    expect(res.res).toBe('error');
    expect(res.message.length).toBeLessThanOrEqual('malformed daemon response: '.length + 200);
  });
});

describe('encodeDaemonFrame', () => {
  it('头部 4 字节小端长度 + JSON payload', () => {
    const frame = encodeDaemonFrame({ cmd: 'ping' });
    const len = frame.readUInt32LE(0);
    expect(len).toBe(frame.byteLength - 4);
    expect(JSON.parse(frame.subarray(4).toString('utf-8'))).toEqual({ cmd: 'ping' });
  });

  it('超限帧抛错', () => {
    expect(() =>
      encodeDaemonFrame({ cmd: 'release_ack', version: 'x'.repeat(DAEMON_MAX_FRAME + 1) }),
    ).toThrow(/frame too large/);
  });
});

describe('decodeDaemonFrame', () => {
  it('整帧 → [响应, 消耗字节数]', () => {
    const frame = encodeResponse({ res: 'pong', version: '1.0.0', http_running: true });
    const [res, consumed] = decodeDaemonFrame(frame)!;
    expect(consumed).toBe(frame.byteLength);
    expect(res).toEqual({ res: 'pong', version: '1.0.0', http_running: true });
  });

  it.each([
    ['空缓冲', Buffer.alloc(0)],
    ['只有 3 字节头', Buffer.from([1, 0, 0])],
    ['payload 未到齐', encodeResponse({ res: 'stopped' }).subarray(0, -1)],
  ])('%s → null（继续等）', (_label, buf) => {
    expect(decodeDaemonFrame(buf)).toBeNull();
  });

  it('长度字段超限抛错', () => {
    const evil = Buffer.alloc(8);
    evil.writeUInt32LE(DAEMON_MAX_FRAME + 1, 0);
    expect(() => decodeDaemonFrame(evil)).toThrow(/exceeds limit/);
  });

  it('粘包：一帧后跟垃圾，消耗字节数只计本帧', () => {
    const frame = encodeResponse({ res: 'stopped' });
    const buf = Buffer.concat([frame, Buffer.from('garbage')]);
    const [res, consumed] = decodeDaemonFrame(buf)!;
    expect(res).toEqual({ res: 'stopped' });
    expect(consumed).toBe(frame.byteLength);
  });

  it('payload 是坏 JSON → error 帧而非抛错', () => {
    const buf = Buffer.alloc(4 + 5);
    buf.writeUInt32LE(5, 0);
    buf.write('nul!!', 4);
    const [res] = decodeDaemonFrame(buf)!;
    expect(res.res).toBe('error');
  });
});

describe('协议常量', () => {
  it('与 Rust 侧约定一致', () => {
    expect(DAEMON_PIPE_NAME).toBe('weq-daemon');
    expect(DAEMON_MAX_FRAME).toBe(1024 * 1024);
  });
});
