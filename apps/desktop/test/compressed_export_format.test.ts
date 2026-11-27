import { describe, expect, it } from 'vitest';
import {
  FULL_FORMATS,
  explicitChatlabFormats,
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
    expect(formats[index + 1]).toEqual({ value: 'jsonl.gz', label: 'JSONL.GZ' });
    expect(formats.filter((format) => format.value === 'jsonl.gz')).toHaveLength(1);
  });
  it('新版按产物选择格式，旧版 ChatLab 预设回填为对应格式', () => {
    expect(isBackendFormat('jsonl.gz')).toBe(true);
    expect(explicitChatlabFormats(['json', 'jsonl', 'html'], true)).toEqual([
      'chatlab.json',
      'chatlab.jsonl',
      'html',
    ]);
    const formats = ['json', 'chatlab.json', 'jsonl.gz'] as const;
    expect(explicitChatlabFormats(formats, false)).toEqual(formats);
  });
});
