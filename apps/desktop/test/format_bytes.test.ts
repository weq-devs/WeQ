// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { formatBytes, formatBytesOrUnknown } from '../src/renderer/src/lib/format';

describe('format_bytes', () => {
  it('0、负数、非法值统一显示 0 B', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(-1)).toBe('0 B');
    expect(formatBytes(Number.NaN)).toBe('0 B');
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('0 B');
  });

  it('B 取整；1024 进制换算', () => {
    expect(formatBytes(1)).toBe('1 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
  });

  it('到 100 以上取整，去掉多余的 .0，数字与单位之间一个空格', () => {
    expect(formatBytes(100 * 1024)).toBe('100 KB');
    expect(formatBytes(999 * 1024)).toBe('999 KB');
    expect(formatBytes(1.5 * 1024 * 1024)).toBe('1.5 MB');
    expect(formatBytes(2 * 1024 * 1024)).toBe('2 MB');
    expect(formatBytes(1.5 * 1024 * 1024 * 1024)).toBe('1.5 GB');
    expect(formatBytes(2 * 1024 * 1024 * 1024 * 1024)).toBe('2 TB');
  });

  it('未知大小与具体数值分开，不把 null 当成 0', () => {
    expect(formatBytesOrUnknown(null)).toBe('未知');
    expect(formatBytesOrUnknown(undefined)).toBe('未知');
    expect(formatBytesOrUnknown(0)).toBe('0 B');
  });
});
