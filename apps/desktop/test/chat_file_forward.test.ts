import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatFileForward } from '../src/main/chat_file_forward';
import type { AccountServices } from '../src/main/context/app_context';
import { findMediaElement } from '../src/main/media_protocol';
import { messageMediaLocations } from '../src/main/message_media_local';
import { downloadUrlToFile } from '@weq/service';
import { forwardWithFileConfirmation } from '../src/renderer/src/lib/chatFileForward';
import { useDialog } from '../src/renderer/src/components/Dialog.shared';

vi.mock('../src/main/media_protocol', () => ({ findMediaElement: vi.fn() }));
vi.mock('../src/main/message_media_local', () => ({
  messageMediaLocations: vi.fn(),
  savedChatFileKey: (file: { msgId: string; token: string }) => `${file.msgId}:${file.token}`,
}));
vi.mock('@weq/service', () => ({ downloadUrlToFile: vi.fn(), getHost: () => ({}) }));

const source = {
  kind: 'chat-file' as const,
  msgId: '100',
  conv: 'u_source',
  name: 'test.txt',
  token: 'old',
};
const file = { fileId: 'new', fileName: 'test.txt', fileSize: 3 };
const target = { peerType: 'c2c' as const, targetId: 'u_target' };

function fixture(confirmed: string[] = []) {
  vi.mocked(findMediaElement).mockResolvedValue({
    conv: 'c2c',
    element: { kind: 'file', fileName: source.name, fileToken: source.token, fileSize: 3 },
  });
  vi.mocked(messageMediaLocations).mockResolvedValue([]);
  const messageSend = {
    prepareFileForward: vi.fn().mockResolvedValue(file),
    sendPreparedFileForward: vi.fn().mockResolvedValue({ ok: true, fileId: 'new' }),
    sendForward: vi.fn().mockResolvedValue({ ok: true }),
    sendFile: vi.fn().mockResolvedValue({ ok: true, fileId: 'uploaded' }),
  };
  const mediaUrl = { resolveFileUrl: vi.fn().mockResolvedValue('https://files.invalid/source') };
  const forward = new ChatFileForward(
    { messageSend, mediaUrl } as unknown as AccountServices,
    target,
    new Set(confirmed),
    () => undefined,
  );
  return { forward, messageSend, mediaUrl };
}

afterEach(() => {
  useDialog.getState().close();
  vi.clearAllMocks();
});

it('sends a target reference and never falls back when publication is uncertain', async () => {
  const { forward, messageSend, mediaUrl } = fixture();
  messageSend.sendPreparedFileForward.mockRejectedValue(new Error('timeout'));
  await expect(forward.sendFile(source)).rejects.toThrow('timeout');
  expect(messageSend.sendPreparedFileForward).toHaveBeenCalledWith(
    expect.objectContaining({ file }),
  );
  expect(messageSend.sendFile).not.toHaveBeenCalled();
  expect(mediaUrl.resolveFileUrl).not.toHaveBeenCalled();
  expect(downloadUrlToFile).not.toHaveBeenCalled();
});

it('passes a merged attachment reference instead of a local path', async () => {
  const { forward, messageSend } = fixture();
  const node = { elements: [{ kind: 'file' as const, source: '', chatFile: source }] };
  await expect(forward.sendCard([node])).resolves.toMatchObject({ status: 'sent' });
  expect(messageSend.sendForward).toHaveBeenCalledWith(
    expect.objectContaining({
      nodes: [
        expect.objectContaining({
          elements: [{ kind: 'file', source: '', fileName: source.name, fileReference: file }],
        }),
      ],
    }),
  );
  expect(downloadUrlToFile).not.toHaveBeenCalled();
});

it('requires explicit approval before downloading, then cleans the temporary upload', async () => {
  const first = fixture();
  first.messageSend.prepareFileForward.mockRejectedValue(new Error('copy refused'));
  const pending = await first.forward.sendFile(source);
  expect(pending).toEqual({
    status: 'confirm',
    files: [{ key: '100:old', name: source.name, size: 3 }],
  });
  expect(downloadUrlToFile).not.toHaveBeenCalled();
  expect(first.messageSend.sendFile).not.toHaveBeenCalled();

  const second = fixture(['100:old']);
  vi.mocked(downloadUrlToFile).mockImplementation(async (_url, path) => {
    await writeFile(path, 'abc');
    return { ok: true, bytes: 3, contentType: 'text/plain', sha256: 'synthetic' };
  });
  let uploadedPath = '';
  second.messageSend.sendFile.mockImplementation(async ({ path }) => {
    uploadedPath = path;
    expect(await stat(path)).toMatchObject({ size: 3 });
    return { ok: true, fileId: 'uploaded' };
  });
  try {
    await expect(second.forward.sendFile(source)).resolves.toMatchObject({ status: 'sent' });
  } finally {
    await second.forward.dispose();
  }
  expect(downloadUrlToFile).toHaveBeenCalledWith(
    'https://files.invalid/source',
    uploadedPath,
    expect.objectContaining({ expectedSize: 3, maxBytes: 3 }),
  );
  await expect(stat(uploadedPath)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('uses an exact local copy before prompting, and does not prompt for an unavailable file', async () => {
  const { forward, messageSend } = fixture();
  messageSend.prepareFileForward.mockRejectedValue(new Error('copy refused'));
  const directory = await mkdtemp(join(tmpdir(), 'weq-forward-test-'));
  try {
    const path = join(directory, 'content');
    await writeFile(path, 'abc');
    vi.mocked(messageMediaLocations).mockResolvedValue([
      { path, kind: 'saved', key: 'synthetic', available: true },
    ]);
    await expect(forward.sendFile(source)).resolves.toMatchObject({ status: 'sent' });
    expect(messageSend.sendFile).toHaveBeenCalledWith(expect.objectContaining({ path }));
    expect(downloadUrlToFile).not.toHaveBeenCalled();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  const expired = fixture();
  expired.messageSend.prepareFileForward.mockRejectedValue(new Error('expired'));
  expired.mediaUrl.resolveFileUrl.mockRejectedValue(new Error('expired'));
  await expect(expired.forward.sendFile(source)).rejects.toThrow('无法从 QQ 取回');
  expect(expired.messageSend.sendFile).not.toHaveBeenCalled();
});

it('cancelling the dialog does not run the confirmed request', async () => {
  const send = vi.fn().mockResolvedValue({
    status: 'confirm',
    files: [{ key: '100:old', name: source.name, size: 3 }],
  });
  const done = forwardWithFileConfirmation(send, '测试会话', () => true);
  await vi.waitFor(() => expect(useDialog.getState().current?.confirm).toBeDefined());
  useDialog.getState().close();
  await expect(done).resolves.toBeNull();
  expect(send.mock.calls).toEqual([[[]]]);
});
