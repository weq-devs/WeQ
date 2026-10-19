import { expect, it, vi } from 'vitest';
import { withRetry, WebAuthError } from '../src/account/web/credential';

const credential = { uin: '10001', skey: 'synthetic-skey', pskey: 'synthetic-pskey' };

it('异步取凭据期间切号，在 HTTP 写请求前中止', async () => {
  let current = true;
  const creds = {
    forDomain: vi.fn(async () => {
      current = false;
      return credential;
    }),
    invalidate: vi.fn(),
  };
  const write = vi.fn(async () => 'sent');
  await expect(
    withRetry(creds, 'qun.qq.com', write, () => {
      if (!current) throw new Error('账号改变');
    }),
  ).rejects.toThrow('账号改变');
  expect(write).not.toHaveBeenCalled();
  expect(creds.invalidate).not.toHaveBeenCalled();
});

it('鉴权失败后的重新取票也复核身份，不跨账号重放', async () => {
  let current = true;
  const creds = { forDomain: vi.fn(async () => credential), invalidate: vi.fn() };
  creds.forDomain
    .mockImplementationOnce(async () => credential)
    .mockImplementationOnce(async () => {
      current = false;
      return credential;
    });
  const write = vi.fn(async () => {
    throw new WebAuthError('expired', -3000);
  });
  await expect(
    withRetry(creds, 'qun.qq.com', write, () => {
      if (!current) throw new Error('账号改变');
    }),
  ).rejects.toThrow('账号改变');
  expect(write).toHaveBeenCalledOnce();
  expect(creds.invalidate).toHaveBeenCalledWith('qun.qq.com');
});
