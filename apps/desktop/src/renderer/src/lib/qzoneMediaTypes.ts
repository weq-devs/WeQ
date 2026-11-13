export interface QzoneVideoType {
  videoId: string;
  isLivePhoto?: boolean;
}

/** 仅按精确视频 ID 合并，保留缺失与显式 false；重复冲突项不参与补全。 */
export function applyQzoneVideoTypes<T extends { videoId: string }>(
  videos: readonly T[],
  types: readonly QzoneVideoType[],
): (T & { isLivePhoto?: boolean })[] {
  const flags = new Map<string, boolean | undefined>();
  for (const type of types) {
    if (!type.videoId) continue;
    flags.set(
      type.videoId,
      flags.has(type.videoId) && flags.get(type.videoId) !== type.isLivePhoto
        ? undefined
        : type.isLivePhoto,
    );
  }
  return videos.map((video) => {
    const flag = flags.get(video.videoId);
    return typeof flag === 'boolean' ? { ...video, isLivePhoto: flag } : video;
  });
}
