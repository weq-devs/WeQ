// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { releaseObjectUrl, retainObjectUrl } from '../src/renderer/src/lib/objectUrl';

afterEach(() => vi.restoreAllMocks());

it('多个消费者共享 Blob，最后一个退出才执行已请求的释放，退出可重复调用', () => {
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  const first = retainObjectUrl('blob:shared');
  const second = retainObjectUrl('blob:shared');
  releaseObjectUrl('blob:shared');
  releaseObjectUrl('blob:shared');
  first();
  first();
  expect(revoke).not.toHaveBeenCalled();
  second();
  second();
  expect(revoke.mock.calls).toEqual([['blob:shared']]);
});

it('消费者退出不擅自释放仍属于草稿的 Blob，也不保留无消费者的地址', () => {
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  retainObjectUrl('blob:draft')();
  expect(revoke).not.toHaveBeenCalled();
  releaseObjectUrl('blob:draft');
  releaseObjectUrl('blob:unused');
  expect(revoke.mock.calls).toEqual([['blob:draft'], ['blob:unused']]);
});

it('远程或本机协议地址不作为 Blob 保留或释放', () => {
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  retainObjectUrl('weq-media://pic?name=fixture.png')();
  retainObjectUrl('https://synthetic.invalid/image.png')();
  expect(revoke).not.toHaveBeenCalled();
});
