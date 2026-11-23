/**
 * `FileResourceService.resolveLocalFile` —— `weq-media://localfile` / `localfilevoice`
 * 的放行规则。
 *
 * 合并转发 / 合成聊天记录里刚选的媒体在**上传前**是本机任意路径，不在 `nt_data`
 * 里，所以预览要有一条受控的通道：只放行 `nt_data` 树内（真实消息的 `localPath`
 * 基本都落在这里）以及用户亲手选中的路径，其余一律 null（渲染层拿不到字节）。
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountSession } from '@weq/account';
import type { Platform } from '@weq/platform';
import { FileResourceService } from '../src/account/file_resource';
import { FileAssistantService } from '../src/account/file_assistant';

let dir: string;
let ntData: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'weq-file-resource-'));
  ntData = join(dir, 'nt_data');
  mkdirSync(join(ntData, 'Pic', '2026-09', 'Ori'), { recursive: true });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function service(storePath?: string): FileResourceService {
  const session = { context: { uin: '10001' } } as unknown as AccountSession;
  const platform = {
    ntDataDir: () => ntData,
    fileDir: () => join(ntData, 'File'),
  } as unknown as Platform;
  return new FileResourceService(session, platform, storePath);
}

/** 造一个真实文件，返回它的绝对路径。 */
function makeFile(relPath: string): string {
  const abs = join(dir, relPath);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, 'x');
  return abs;
}

describe('FileResourceService.resolveLocalFile', () => {
  it('放行 nt_data 树内的文件（真实消息 localPath 指向的 QQ 缓存）', async () => {
    const file = makeFile(join('nt_data', 'Pic', '2026-09', 'Ori', 'a.png'));
    await expect(service().resolveLocalFile(file)).resolves.toBe(file);
  });

  it('拒绝 nt_data 之外、也没被选中的路径', async () => {
    const file = makeFile('outside/secret.txt');
    await expect(service().resolveLocalFile(file)).resolves.toBeNull();
  });

  it('放行用户亲手选中的路径（trustPath 登记后）', async () => {
    const file = makeFile('Pictures/picked.png');
    const svc = service();
    await expect(svc.resolveLocalFile(file)).resolves.toBeNull();
    svc.trustPath(file);
    await expect(svc.resolveLocalFile(file)).resolves.toBe(file);
  });

  it('撤销临时预览只影响指定文件，不撤销其他选中文件或账号原有媒体', async () => {
    const preview = makeFile('private-preview/temporary.png');
    const other = makeFile('Pictures/another.png');
    const media = makeFile('nt_data/Pic/2026-09/Ori/cached.png');
    const svc = service();
    svc.trustPath(preview);
    svc.trustPath(other);
    svc.untrustPath(preview);
    svc.untrustPath(media);
    await expect(svc.resolveLocalFile(preview)).resolves.toBeNull();
    await expect(svc.resolveLocalFile(other)).resolves.toBe(other);
    await expect(svc.resolveLocalFile(media)).resolves.toBe(media);
  });

  it('目录 / 不存在的路径一律 null', async () => {
    const svc = service();
    await expect(svc.resolveLocalFile(join(ntData, 'Pic'))).resolves.toBeNull();
    await expect(svc.resolveLocalFile(join(ntData, 'Pic', 'nope.png'))).resolves.toBeNull();
    await expect(svc.resolveLocalFile('')).resolves.toBeNull();
  });
});

it('发送原路径按附件标识持久化，重开后可用，不匹配同名附件或失效文件', async () => {
  const file = makeFile('outside/report.txt');
  const index = join(dir, 'config', 'sent_files.json');
  service(index).rememberSentFile('sent-token', 'report.txt', 1, file);
  const reopened = service(index);
  await expect(reopened.resolveSentFile('sent-token', 'report.txt')).resolves.toBe(file);
  await expect(reopened.resolveSentFile('other-token', 'report.txt')).resolves.toBeNull();
  await expect(
    service(join(dir, 'other-source.json')).resolveSentFile('sent-token', 'report.txt'),
  ).resolves.toBeNull();
  writeFileSync(file, 'changed');
  await expect(reopened.resolveSentFile('sent-token', 'report.txt')).resolves.toBeNull();
  rmSync(file);
  await expect(reopened.resolveSentFile('sent-token', 'report.txt')).resolves.toBeNull();
});

it('同一附件的并发定位共享数据库读取，失败结束后仍可重新查询', async () => {
  const getByMsgId = vi
    .fn(async (_id: bigint) => null)
    .mockRejectedValueOnce(new Error('database busy'));
  const svc = new FileAssistantService({
    fileAssistant: { getByMsgId },
  } as unknown as AccountSession);
  const pending = [svc.getFileInfoByMsgId(1n), svc.getFileInfoByMsgId(1n)];
  const unrelated = svc.getFileInfoByMsgId(2n);
  expect(getByMsgId.mock.calls).toEqual([[1n], [2n]]);
  expect((await Promise.allSettled(pending)).map(({ status }) => status)).toEqual([
    'rejected',
    'rejected',
  ]);
  await expect(unrelated).resolves.toBeNull();
  await expect(svc.getFileInfoByMsgId(1n)).resolves.toBeNull();
  expect(getByMsgId.mock.calls).toEqual([[1n], [2n], [1n]]);
});
