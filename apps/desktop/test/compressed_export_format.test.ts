import { describe, expect, it } from 'vitest';
import {
  FULL_FORMATS,
  CHATLAB_FORMATS,
  QZONE_FORMATS,
  FRIEND_FORMATS,
  MEMBER_FORMATS,
  COLLECTION_FORMATS,
  isBackendFormat,
} from '../src/renderer/src/views/export/types';

describe('压缩 JSONL 格式入口', () => {
  it.each(
    [FULL_FORMATS, QZONE_FORMATS, FRIEND_FORMATS, MEMBER_FORMATS, COLLECTION_FORMATS].map(
      (formats) => ({ formats }),
    ),
  )('各内容列表中紧跟 JSONL，且仅出现一次', ({ formats }) => {
    const index = formats.findIndex((format) => format.value === 'jsonl');
    expect(formats[index + 1]).toEqual({ value: 'jsonl.gz', label: 'JSONL（压缩）' });
    expect(formats.filter((format) => format.value === 'jsonl.gz')).toHaveLength(1);
  });
  it('后端支持压缩 JSONL，ChatLab 仍仅提供交换格式', () => {
    expect(isBackendFormat('jsonl.gz')).toBe(true);
    expect(CHATLAB_FORMATS.some((format) => format.value === 'jsonl.gz')).toBe(false);
  });
});
