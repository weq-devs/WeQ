/**
 * 媒体扫描的去重（`media_scan.ts`）—— 钉住「同一条语音被转发 / 重发时别丢转写」。

 * 场景：同一条语音发了两次（同一个 stem），**先出现的那条没转过文字、后出现的那条转过**
 * （QQ 的 45923 只在转过的那条上）。以前去重是「keep first」且不合并，于是先出现的那条
 * 当代表，转写就白丢了 —— 导出里本该显示文字的语音又变回文件名锚点。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MsgService } from '../src/account/msg';
import { scanConvMedia, type MediaDirs } from '../src/account/export/media_scan';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'weq-media-scan-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function dirs(): MediaDirs {
  return {
    pic: join(dir, 'Pic'),
    video: join(dir, 'Video'),
    ptt: join(dir, 'Ptt'),
    emoji: join(dir, 'Emoji', 'emoji-recv'),
    file: join(dir, 'File'),
  };
}

/** 一条带语音元素的消息（seq 递增，sendTime 递增）。 */
function groupMsg(seq: number, pttTranscript?: string) {
  const fileName = 'abcdef0123456789abcdef0123456789.silk';
  return {
    msgId: BigInt(seq),
    msgSeq: BigInt(seq),
    sendTime: BigInt(1_700_000_000 + seq),
    senderUin: 10001n,
    targetGroupCode: '10002',
    elements: [
      {
        type: 'ptt' as const,
        data: {
          fileName,
          fileToken: 'token-1',
          fileSize: 4096,
          uploadTime: 1_700_000_000,
          uploadTimestamp: 1_700_000_000,
          fileTTL: 777600,
          md5: 'a'.repeat(32),
          pttDuration: 3,
          ...(pttTranscript ? { pttTranscript } : {}),
        },
      },
    ],
  };
}

describe('scanConvMedia 去重', () => {
  it('同一条语音：先出现的那条没转写、后出现的有 → 合并进代表项，别丢', async () => {
    const pages: unknown[][] = [[groupMsg(1), groupMsg(2, '第二条才转过文字')], []];
    let call = 0;
    const msgs = {
      getGroupAfter: vi.fn(async () => (pages[call++] ?? []) as never),
      getGroupSeqlessAfterRowId: vi.fn(async () => [] as never),
    } as unknown as MsgService;

    const scan = await scanConvMedia(msgs, 'group', '10002', dirs(), { pageSize: 10 });

    // 两个引用去重成一条（同一个 stem），并且带上了第二条的转写
    expect(scan.uniqueFiles).toBe(1);
    expect(scan.found.length + scan.missing.length).toBe(1);
    const ref = [...scan.found, ...scan.missing][0]!;
    expect(ref.transcript).toBe('第二条才转过文字');
  });

  it('先出现的那条已经有转写 → 不会被后面的空值覆盖', async () => {
    const pages: unknown[][] = [[groupMsg(1, '第一条的转写'), groupMsg(2)], []];
    let call = 0;
    const msgs = {
      getGroupAfter: vi.fn(async () => (pages[call++] ?? []) as never),
      getGroupSeqlessAfterRowId: vi.fn(async () => [] as never),
    } as unknown as MsgService;

    const scan = await scanConvMedia(msgs, 'group', '10002', dirs(), { pageSize: 10 });
    const ref = [...scan.found, ...scan.missing][0]!;
    expect(ref.transcript).toBe('第一条的转写');
  });
});
