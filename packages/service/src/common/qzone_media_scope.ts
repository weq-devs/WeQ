interface MediaSource {
  images: string[];
  videos: Array<{ videoId?: string; videoUrl?: string }>;
}

/** 仅按准确媒体身份判断转发借用的原帖素材，不比较标题或相似 URL。 */
export function qzoneImageCompletionScope(
  post: MediaSource & { repost?: MediaSource },
): 'post' | 'repost' {
  const original = post.repost;
  if (!original || post.images.length + post.videos.length === 0) return 'post';
  const images = new Set(original.images);
  const mirrored =
    post.images.every((url) => images.has(url)) &&
    post.videos.every((video) =>
      original.videos.some(
        (other) =>
          (video.videoId && video.videoId === other.videoId) ||
          (video.videoUrl && video.videoUrl === other.videoUrl),
      ),
    );
  return mirrored ? 'repost' : 'post';
}
