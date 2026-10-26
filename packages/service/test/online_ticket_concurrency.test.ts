import { expect, it, vi } from 'vitest';
import { encode, FetchDownloadRkeys } from '@weq/protocol';
import { fetchClientKey, fetchDownloadRkeys } from '../src/account/online_ticket';

it('同账号进程的 clientKey 在途请求合并，完成后不额外缓存过期票据', async () => {
  const nt = {
    ptFetchClientKey: vi.fn(async () => ({
      success: true,
      msg: '',
      clientKey: 'synthetic-ck',
      keyIndex: '19',
      ttlSeconds: 1800,
    })),
  };
  await Promise.all([fetchClientKey(nt, 42, '10001'), fetchClientKey(nt, 42, '10001')]);
  expect(nt.ptFetchClientKey).toHaveBeenCalledOnce();
  await fetchClientKey(nt, 42, '10001');
  expect(nt.ptFetchClientKey).toHaveBeenCalledTimes(2);
});

it('不同 clientKey 账号或 PID 不合并，失败后可重试', async () => {
  const nt = {
    ptFetchClientKey: vi.fn(async () => ({
      success: true,
      msg: '',
      clientKey: 'synthetic-ck',
      keyIndex: '19',
      ttlSeconds: 1800,
    })),
  };
  await Promise.all([
    fetchClientKey(nt, 42, '10001'),
    fetchClientKey(nt, 42, '10002'),
    fetchClientKey(nt, 43, '10001'),
  ]);
  expect(nt.ptFetchClientKey).toHaveBeenCalledTimes(3);
  nt.ptFetchClientKey.mockRejectedValueOnce(new Error('合成网络错误'));
  await expect(fetchClientKey(nt, 42, '10001')).rejects.toThrow('合成网络错误');
  await expect(fetchClientKey(nt, 42, '10001')).resolves.toMatchObject({
    clientKey: 'synthetic-ck',
  });
});

it('相同图片 rkey 请求合并，显式媒体类型不混用', async () => {
  const nt = {
    sendOidbPacket: vi.fn(async () =>
      Buffer.from(
        encode(FetchDownloadRkeys.respSchema, {
          downloadRkey: {
            rkeys: [{ rkey: 'synthetic-rkey', type: 10, rkeyTtlSec: 3600, rkeyCreateTime: 100 }],
          },
        }),
      ),
    ),
  };
  const results = await Promise.all([
    fetchDownloadRkeys(nt, 42, undefined, '10001'),
    fetchDownloadRkeys(nt, 42, undefined, '10001'),
    fetchDownloadRkeys(nt, 42, [14, 24], '10001'),
  ]);
  expect(nt.sendOidbPacket).toHaveBeenCalledTimes(2);
  for (const result of results)
    expect(result).toEqual([
      { rkey: 'synthetic-rkey', type: 10, ttlSeconds: 3600, createTime: 100 },
    ]);
});

it('rkey 不跨账号合并，缺少账号的兼容调用保持独立', async () => {
  const nt = { sendOidbPacket: vi.fn(async () => Buffer.alloc(0)) };
  await Promise.all([
    fetchDownloadRkeys(nt, 42, undefined, '10001'),
    fetchDownloadRkeys(nt, 42, undefined, '10002'),
    fetchDownloadRkeys(nt, 42),
    fetchDownloadRkeys(nt, 42),
  ]);
  expect(nt.sendOidbPacket).toHaveBeenCalledTimes(4);
});
