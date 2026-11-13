// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { applyQzoneVideoTypes } from '../src/renderer/src/lib/qzoneMediaTypes';

describe('空间实况类型关联', () => {
  it('按视频 ID 而非顺序、时长或封面合并', () => {
    const videos = [
      { videoId: 'normal', duration: 2000 },
      { videoId: 'live', duration: 22000 },
      { videoId: 'unknown', duration: 2000 },
    ];
    expect(
      applyQzoneVideoTypes(videos, [
        { videoId: 'live', isLivePhoto: true },
        { videoId: 'normal', isLivePhoto: false },
      ]),
    ).toEqual([
      { ...videos[0], isLivePhoto: false },
      { ...videos[1], isLivePhoto: true },
      videos[2],
    ]);
    expect(videos[0]).not.toHaveProperty('isLivePhoto');
  });
  it('缺失和重复冲突不变成 false 或按位置覆盖', () => {
    expect(
      applyQzoneVideoTypes(
        [{ videoId: 'same' }, { videoId: '' }],
        [
          { videoId: 'same', isLivePhoto: true },
          { videoId: 'same', isLivePhoto: false },
          { videoId: 'same', isLivePhoto: true },
        ],
      ),
    ).toEqual([{ videoId: 'same' }, { videoId: '' }]);
  });
});
