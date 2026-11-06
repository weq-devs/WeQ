import { FileUploadStaging } from './ipc/routers/album_video_staging';

/** 浏览器选择的草稿附件复用既有分段实现，闲置后自动回收。 */
export const pickedBrowserFiles = new FileUploadStaging(30 * 60000, {
  label: '附件',
  minBytes: 1,
  maxBytes: 2 * 1024 ** 3,
  prefix: 'weq-browser-picker-',
  fileName: 'attachment',
  maxUploads: 256,
  maxTotalBytes: 8 * 1024 ** 3,
});
