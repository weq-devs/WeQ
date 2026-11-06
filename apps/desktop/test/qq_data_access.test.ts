// @vitest-environment node
import { beforeEach, expect, test, vi } from 'vitest';

const io = vi.hoisted(() => ({
  openSync: vi.fn(),
  readSync: vi.fn(),
  closeSync: vi.fn(),
  readdirSync: vi.fn(),
}));
vi.mock('node:fs', () => io);
import { checkQqDataAccess } from '../src/main/qq_data_access';

const options = {
  kind: 'darwin',
  roots: ['/fixture/QQ'],
  executable: '/Applications/weQ.app/Contents/MacOS/weQ',
};
beforeEach(() => {
  vi.resetAllMocks();
  io.readdirSync.mockReturnValue([]);
  io.openSync.mockImplementation(() => {
    throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  });
});

test('缺少数据库不是授权失败；其他平台不探测', () => {
  expect(checkQqDataAccess(options).status).toBe('not-found');
  io.readdirSync.mockClear();
  expect(checkQqDataAccess({ ...options, kind: 'linux' }).status).toBe('unsupported');
  expect(io.readdirSync).not.toHaveBeenCalled();
});

test('原进程只读打开并读取数据库，关闭句柄；重试不沿用旧拒绝', () => {
  io.openSync.mockImplementation(() => {
    throw Object.assign(new Error('denied'), { code: 'EPERM' });
  });
  expect(checkQqDataAccess(options).status).toBe('denied');
  io.openSync.mockReturnValue(42);
  io.readSync.mockReturnValue(1);
  expect(checkQqDataAccess(options)).toMatchObject({
    status: 'readable',
    applicationPath: '/Applications/weQ.app',
  });
  expect(io.openSync).toHaveBeenCalledWith('/fixture/QQ/global/nt_db/login.db', 'r');
  expect(io.readSync).toHaveBeenCalled();
  expect(io.closeSync).toHaveBeenCalledWith(42);
});

test('实际读取失败也分类，错误时仍关闭句柄，不把 I/O 损坏归为授权', () => {
  io.openSync.mockReturnValue(42);
  io.readSync.mockImplementation(() => {
    throw Object.assign(new Error('I/O failure'), { code: 'EIO' });
  });
  expect(checkQqDataAccess(options).status).toBe('error');
  expect(io.closeSync).toHaveBeenCalledWith(42);
  io.readSync.mockImplementation(() => {
    throw Object.assign(new Error('denied'), { code: 'EACCES' });
  });
  expect(checkQqDataAccess(options).status).toBe('denied');
});

test('目录不可枚举也能识别；无错误码的其他 Operation not permitted 不猜为磁盘授权', () => {
  io.readdirSync.mockImplementation(() => {
    throw Object.assign(new Error('denied'), { code: 'EPERM' });
  });
  expect(checkQqDataAccess(options).status).toBe('denied');
  io.readdirSync.mockImplementation(() => {
    throw new Error('Operation not permitted');
  });
  expect(checkQqDataAccess(options).status).toBe('error');
});

test('login.db 可读但消息库被拒绝，仍显示受限路径，不被其他可读文件掩盖', () => {
  io.readdirSync.mockReturnValue(['nt_qq_fixture']);
  io.openSync.mockImplementation((path: string) => {
    if (path.endsWith('nt_msg.db')) throw Object.assign(new Error('denied'), { code: 'EPERM' });
    return 42;
  });
  io.readSync.mockReturnValue(1);
  const result = checkQqDataAccess(options);
  expect(result.status).toBe('denied');
  expect(result.issues.some((issue) => issue.path.endsWith('/nt_db/nt_msg.db'))).toBe(true);
});
