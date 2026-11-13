import { expect, it, vi } from 'vitest';
import { ProfileInteractionWrites } from '../src/account/profile_interactions';
import * as p from '@weq/protocol';
const nt = { sendPacket: vi.fn() };
const signature = { id: '66656564', createdAt: 123 };
const label = { id: '12', text: '旅行', cover: null, photoCount: 0, photoCursor: null, photos: [] };
function fixture() {
  let pid = 5;
  const api = {
    ...p,
    setSignatureLike: vi.fn(async () => {}),
    addSignatureComment: vi.fn(async () => '9007199254740993'),
    deleteSignatureComment: vi.fn(async () => {}),
    getSignatureHistory: vi.fn(async () => ({
      targetUin: '10002',
      items: [
        {
          ...signature,
          text: '',
          action: null,
          data: null,
          location: null,
          commentItems: [
            {
              id: '22',
              fromUin: '10003',
              fromName: null,
              toName: null,
              toUin: null,
              replyId: null,
              text: '评论',
              time: 123,
            },
          ],
        },
      ],
      hasMore: false,
      nextCursor: null,
      paginationError: null,
    })),
    getPersonalityLabels: vi.fn(async () => ({
      targetUin: '10001',
      labels: [label],
      totalPhotos: 0,
      closed: false,
    })),
    getPersonalityPhotos: vi.fn(async () => ({
      targetUin: '10001',
      items: [],
      hasMore: false,
      nextCursor: null,
      paginationError: null,
    })),
    uploadPersonalityPhoto: vi.fn(async () => ({ photoId: '23', url: 'https://p.qpic.cn/test' })),
  };
  return {
    api,
    service: new ProfileInteractionWrites(nt, '10001', () => pid, api),
    switchPid: () => {
      pid = 6;
    },
  };
}
it('本人标签上传携带身份，目录暂未同步仍返回照片 ID，且不重复上传', async () => {
  const { service, api } = fixture();
  expect(await service.uploadPhoto('10001', '12', new Uint8Array([1]))).toMatchObject({
    photoId: '23',
    observed: false,
    state: 'accepted',
  });
  expect(api.uploadPersonalityPhoto).toHaveBeenCalledTimes(1);
  expect(api.uploadPersonalityPhoto).toHaveBeenCalledWith(
    nt,
    5,
    expect.objectContaining({ uin: '10001', labelId: '12', beforeSend: expect.any(Function) }),
  );
});
it('他人标签在上传前拒绝', async () => {
  const { service, api } = fixture();
  await expect(service.uploadPhoto('10002', '12', new Uint8Array([1]))).rejects.toThrow('自己的');
  expect(api.uploadPersonalityPhoto).not.toHaveBeenCalled();
});
it('目录查询时进程变化，停止后续上传', async () => {
  const { service, api, switchPid } = fixture();
  api.getPersonalityLabels.mockImplementationOnce(async () => {
    switchPid();
    return { targetUin: '10001', labels: [label], totalPhotos: 0, closed: false };
  });
  await expect(service.uploadPhoto('10001', '12', new Uint8Array([1]))).rejects.toThrow('切换');
  expect(api.uploadPersonalityPhoto).not.toHaveBeenCalled();
});
it('并发提交同一写操作只发送一次，结束后可再次操作', async () => {
  const { service, api } = fixture();
  let release!: () => void;
  api.setSignatureLike.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const first = service.signatureLike('10001', signature, true);
  await expect(service.signatureLike('10001', signature, true)).rejects.toThrow('等待');
  release();
  await first;
  await service.signatureLike('10001', signature, false);
  expect(api.setSignatureLike).toHaveBeenCalledTimes(2);
});
it('删除他人签名评论时核对评论作者；本人签名直接使用本人身份', async () => {
  const { service, api } = fixture();
  await expect(service.removeSignatureComment('10002', signature, '22')).rejects.toThrow(
    '自己发布',
  );
  expect(api.deleteSignatureComment).not.toHaveBeenCalled();
  await service.removeSignatureComment('10001', signature, '22');
  expect(api.deleteSignatureComment).toHaveBeenCalledWith(
    nt,
    5,
    '10001',
    '10001',
    signature.id,
    '22',
  );
});
