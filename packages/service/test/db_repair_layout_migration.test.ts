/**
 * 页布局检测的单测：只钉用户允许的两个判据（大小 + 两页状态）。
 *
 * 这里刻意不引入 SQLite / native：检测读的是原始字节，所以用稀疏文件造出 1 GiB
 * 以上的“文件形状”即可，不会真的写 1 GiB 数据。
 */

import { closeSync, ftruncateSync, mkdtempSync, openSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LAYOUT_MIN_BYTES,
  LAYOUT_PAGE_SIZE,
  QQ_RESERVED_PAGE,
  STANDARD_RESERVED_PAGE,
  classifyLayoutPages,
  probeDbLayout,
} from '../src/account/db_repair/layout_migration';

function makeFile(bytes: number, pages: Record<number, Buffer>, headerOffset = 0): string {
  const dir = mkdtempSync(join(tmpdir(), 'weq-layout-probe-'));
  const path = join(dir, 'nt_msg.db');
  const fd = openSync(path, 'w');
  try {
    ftruncateSync(fd, bytes);
    if (headerOffset > 0) {
      const header = Buffer.alloc(headerOffset);
      header.write('SQLite header 3\0');
      header.write('QQ_NT DB', 32);
      writeSync(fd, header, 0, header.length, 0);
    }
    for (const [page, data] of Object.entries(pages)) {
      const offset = headerOffset + (Number(page) - 1) * LAYOUT_PAGE_SIZE;
      writeSync(fd, data, 0, data.length, offset);
    }
  } finally {
    closeSync(fd);
  }
  return path;
}

const data = Buffer.from('x'.repeat(64));

describe('classifyLayoutPages', () => {
  it('262144 零 + 262145 有数据 → QQ 布局', () => {
    expect(classifyLayoutPages('zero', 'data')).toEqual({ layout: 'qq', needsMigration: false });
  });

  it('262144 有数据 + 262145 零 → standard 布局，建议迁移', () => {
    expect(classifyLayoutPages('data', 'zero')).toEqual({
      layout: 'standard',
      needsMigration: true,
    });
  });

  it('其它组合一律 unknown，不提示迁移', () => {
    for (const [left, right] of [
      ['zero', 'zero'],
      ['data', 'data'],
      ['missing', 'missing'],
      ['zero', 'missing'],
    ] as const) {
      expect(classifyLayoutPages(left, right)).toEqual({
        layout: 'unknown',
        needsMigration: false,
      });
    }
  });
});

describe('probeDbLayout', () => {
  it('不超过 1 GiB 时不看页状态，直接 unknown', () => {
    const path = makeFile(LAYOUT_MIN_BYTES, {});
    try {
      const probe = probeDbLayout(path);
      expect(probe.needsMigration).toBe(false);
      expect(probe.layout).toBe('unknown');
      expect(probe.summary).toContain('不超过 1 GiB');
    } finally {
      rmSync(join(path, '..'), { recursive: true, force: true });
    }
  });

  it('QQ 头 + standard 页布局 → 判定为需要迁移', () => {
    const bytes = LAYOUT_MIN_BYTES + LAYOUT_PAGE_SIZE * 4;
    const path = makeFile(bytes, { [QQ_RESERVED_PAGE]: data }, 1024);
    try {
      const probe = probeDbLayout(path);
      expect(probe.headerOffset).toBe(1024);
      expect(probe.page262144).toBe('data');
      expect(probe.page262145).toBe('zero');
      expect(probe.layout).toBe('standard');
      expect(probe.needsMigration).toBe(true);
    } finally {
      rmSync(join(path, '..'), { recursive: true, force: true });
    }
  });

  it('QQ 头 + QQ 页布局 → 不提示迁移', () => {
    const bytes = LAYOUT_MIN_BYTES + LAYOUT_PAGE_SIZE * 4;
    const path = makeFile(bytes, { [STANDARD_RESERVED_PAGE]: data }, 1024);
    try {
      const probe = probeDbLayout(path);
      expect(probe.layout).toBe('qq');
      expect(probe.needsMigration).toBe(false);
    } finally {
      rmSync(join(path, '..'), { recursive: true, force: true });
    }
  });
});
