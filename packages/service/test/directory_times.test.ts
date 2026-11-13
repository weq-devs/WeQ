import { expect, it, vi } from 'vitest';
import { DirectoryTimeReader } from '../src/account/directory_times';
const row = (time: number, senderUid = 'u_me', senderUin = '123') => ({
  conversation: '10001',
  time,
  senderUid,
  senderUin,
});
it('一次请求一页，按真实时间取最大，不按游标顺序；无本人身份不猜发言', async () => {
  const page = vi
    .fn()
    .mockResolvedValueOnce({
      items: [row(100, 'u_other')],
      cursor: '9007199254740993',
      done: false,
    })
    .mockResolvedValueOnce({ items: [row(90), row(101, '', '123')], done: true });
  const reader = new DirectoryTimeReader(page, 'u_me', '123');
  expect(await reader.read()).toEqual({
    rows: { '10001': { time: 100, mine: null } },
    done: false,
  });
  expect(page).toHaveBeenCalledOnce();
  expect(await reader.read()).toEqual({ rows: { '10001': { time: 101, mine: 101 } }, done: true });
  expect(page).toHaveBeenLastCalledWith('9007199254740993');
  await reader.read();
  expect(page).toHaveBeenCalledTimes(2);
  const unknown = new DirectoryTimeReader(
    async () => ({ items: [row(1, 'u_other')], done: true }),
    '',
    '',
  );
  expect((await unknown.read()).rows['10001']?.mine).toBeNull();
});
it('UID 冲突时不因号码相同误认本人，更新后删除和空记录不残留', async () => {
  const page = vi
    .fn()
    .mockResolvedValueOnce({ items: [row(100, 'u_other', '123')], done: true })
    .mockResolvedValueOnce({ items: [], done: true });
  const reader = new DirectoryTimeReader(page, 'u_me', '123');
  expect((await reader.read()).rows['10001']?.mine).toBeNull();
  reader.invalidate();
  expect(await reader.read()).toEqual({ rows: {}, done: true });
});
it('并发请求共享页面，失败不推进游标，可在下次继续', async () => {
  const page = vi
    .fn()
    .mockRejectedValueOnce(new Error('busy'))
    .mockResolvedValueOnce({ items: [row(1)], done: true });
  const reader = new DirectoryTimeReader(page, 'u_me', '123');
  const a = reader.read(),
    b = reader.read();
  expect(a).toBe(b);
  await expect(a).rejects.toThrow('busy');
  expect((await reader.read()).done).toBe(true);
  expect(page).toHaveBeenCalledTimes(2);
});
