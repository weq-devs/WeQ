// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';

const { app, findFile, getGroupMessageById, resolve } = vi.hoisted(() => {
  const findFile = vi.fn();
  const getGroupMessageById = vi.fn();
  return {
    app: { account: {}, services: { msgs: { getGroupMessageById }, fileSearch: { findFile } } },
    findFile,
    getGroupMessageById,
    resolve: vi.fn(),
  };
});

vi.mock('../src/main/context/app_context', () => ({ getAppContext: () => app }));
vi.mock('../src/main/media_protocol', () => ({ resolveOcrChatImageFile: resolve }));

import { chatImageFileForTool } from '../src/main/mcp/chat_image_file';

const target = { kind: 'group', conv: '123', msgId: '9007199254740993', imageIndex: 1 } as const;
const row = {
  targetGroupCode: '123',
  sendTime: 1792461600n,
  elements: [
    { type: 'text', data: { textContent: 'fixture' } },
    { type: 'pic', data: { subType: 1, fileName: 'emoji.png' } },
    { type: 'pic', data: { fileName: 'actual.png', fileToken: 'token' } },
  ],
};

beforeEach(() => {
  vi.resetAllMocks();
  getGroupMessageById.mockResolvedValue(row);
});

it('uses the existing original downloader for the requested image index without returning its token', async () => {
  resolve.mockResolvedValue({ path: '/fixture/actual.png', variant: 'downloaded' });
  const result = await chatImageFileForTool(target);
  expect(result).toEqual({
    ...target,
    found: true,
    localPath: '/fixture/actual.png',
    variant: 'original',
  });
  expect(getGroupMessageById).toHaveBeenCalledWith('123', 9007199254740993n);
  expect(resolve.mock.calls[0]?.[0].get('name')).toBe('actual.png');
  expect(resolve.mock.calls[0]?.[1]).toBe(true);
  expect(findFile).not.toHaveBeenCalled();
});

it('keeps thumbnail provenance and does not resolve a row from another conversation', async () => {
  resolve.mockRejectedValue(new Error('original not available'));
  findFile.mockResolvedValue({ source: null, thumb: '/fixture/thumb.png' });
  expect(await chatImageFileForTool(target)).toMatchObject({ variant: 'thumbnail' });
  getGroupMessageById.mockResolvedValue({ ...row, targetGroupCode: '456' });
  resolve.mockClear();
  expect(await chatImageFileForTool(target)).toEqual({ ...target, found: false });
  expect(resolve).not.toHaveBeenCalled();
});
