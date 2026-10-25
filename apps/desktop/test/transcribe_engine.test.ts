// @vitest-environment node
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ fork: vi.fn(), resolve: vi.fn() }));
vi.mock('node:child_process', () => ({ fork: mocks.fork }));
vi.mock('../src/main/worker_path', () => ({ resolveChildWorkerPath: mocks.resolve }));
import { transcribeWav } from '../src/main/transcribe/engine';

class Worker extends EventEmitter {
  stderr = new PassThrough();
  connected = true;
  send = vi.fn();
  disconnect = vi.fn(() => {
    this.connected = false;
  });
  kill = vi.fn();
}

describe('语音转写子进程', () => {
  let worker: Worker;
  const paths = { model: '/fixture/model.onnx', tokens: '/fixture/tokens.txt' };
  beforeEach(() => {
    worker = new Worker();
    mocks.fork.mockReturnValue(worker);
    mocks.resolve.mockReturnValue('/fixture/Resources/out/main/transcribeWorker.mjs');
  });
  afterEach(() => vi.clearAllMocks());

  it('使用共用解析器返回的实体 worker，成功结果保留富标签字段', async () => {
    const result = transcribeWav(Buffer.alloc(44), paths);
    expect(mocks.resolve).toHaveBeenCalledWith('transcribeWorker.mjs', expect.any(String));
    expect(mocks.fork).toHaveBeenCalledWith(
      '/fixture/Resources/out/main/transcribeWorker.mjs',
      [],
      expect.objectContaining({ stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }),
    );
    worker.emit('message', { type: 'final', text: '你好', emotion: null, events: [] });
    expect(await result).toEqual({ success: true, text: '你好', emotion: null, events: [] });
    expect(worker.kill).toHaveBeenCalledOnce();
  });

  it('缺少实体 worker 时直接返回安装包诊断，不启动进程', async () => {
    mocks.resolve.mockImplementationOnce(() => {
      throw new Error('缺少可执行的 transcribeWorker.mjs');
    });
    expect(await transcribeWav(Buffer.alloc(44), paths)).toMatchObject({
      success: false,
      error: expect.stringContaining('缺少可执行'),
    });
    expect(mocks.fork).not.toHaveBeenCalled();
  });

  it('等待 stderr 排空后报告异常退出，并限制诊断长度', async () => {
    const result = transcribeWav(Buffer.alloc(44), paths);
    worker.emit('exit', 1, null);
    worker.stderr.write(`${'x'.repeat(10_000)}\nMODULE_NOT_FOUND: transcribeWorker.mjs`);
    worker.emit('close', 1, null);
    const response = await result;
    expect(response.success).toBe(false);
    expect(response.error).toContain('code 1');
    expect(response.error).toContain('MODULE_NOT_FOUND');
    expect(response.error!.length).toBeLessThan(5_000);
  });

  it('明确的 IPC 错误不会被退出码覆盖，断开连接后也能安全收尾', async () => {
    const result = transcribeWav(Buffer.alloc(44), paths);
    worker.connected = false;
    worker.emit('message', { type: 'error', error: '语音识别引擎加载失败' });
    worker.emit('close', 1, null);
    expect(await result).toEqual({ success: false, error: '语音识别引擎加载失败' });
    expect(worker.disconnect).not.toHaveBeenCalled();
  });

  it('原生崩溃和其他退出信号有明确诊断', async () => {
    const crashed = transcribeWav(Buffer.alloc(44), paths);
    worker.emit('close', null, 'SIGSEGV');
    expect((await crashed).error).toContain('段错误');
    const killed = transcribeWav(Buffer.alloc(44), paths);
    worker.emit('close', null, 'SIGKILL');
    expect((await killed).error).toContain('SIGKILL');
  });

  it('IPC 请求发送失败时返回诊断并结束子进程', async () => {
    worker.send.mockImplementationOnce((_params, callback) => {
      callback(new Error('channel closed'));
    });
    expect(await transcribeWav(Buffer.alloc(44), paths)).toEqual({
      success: false,
      error: expect.stringContaining('channel closed'),
    });
    expect(worker.kill).toHaveBeenCalledOnce();
  });
});
