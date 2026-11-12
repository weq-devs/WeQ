export function groupAlbumMediaKey(media: {
  image?: { lloc?: string } | null;
  video?: { id?: string } | null;
  originalUrl?: string;
  previewUrl?: string;
}) {
  if (media.image?.lloc) return `img:${media.image.lloc}`;
  if (media.video?.id) return `vid:${media.video.id}`;
  return `url:${media.originalUrl || media.previewUrl || ''}`;
}
export function qzoneAlbumMediaKey(photo: {
  picKey?: string;
  url?: string;
  thumbUrl?: string;
  id?: string;
  uploadTime?: number;
  name?: string;
}) {
  return (
    photo.picKey || photo.url || photo.thumbUrl || `${photo.id}:${photo.uploadTime}:${photo.name}`
  );
}
