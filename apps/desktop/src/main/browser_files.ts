import { join } from 'node:path';
import { PICKED_BROWSER_FILE_MAX_BYTES } from '../shared/browser_file_upload';
import { FileUploadStaging } from './ipc/routers/album_video_staging';
import type { AccountServices } from './context/app_context';
import { getInitializedAppDataRoot } from './context/backup_context';

export function accountUploadPersistence(folder: string) {
  return {
    root: () => {
      const root = getInitializedAppDataRoot();
      return root ? join(root, 'cache', folder) : undefined;
    },
    ownerKey: (owner: object) => {
      const record = (owner as AccountServices).accountConfig.getRecord();
      return record?.configId
        ? JSON.stringify([record.uin, record.configId, record.dataDir])
        : undefined;
    },
  };
}

/** 浏览器选择的草稿附件复用既有分段实现，闲置后自动回收。 */
export const pickedBrowserFiles = new FileUploadStaging(30 * 60000, {
  label: '附件',
  minBytes: 1,
  maxBytes: PICKED_BROWSER_FILE_MAX_BYTES,
  prefix: 'weq-browser-picker-',
  fileName: 'attachment',
  maxUploads: 256,
  maxTotalBytes: 8 * 1024 ** 3,
  persistence: accountUploadPersistence('picked-file-transfer'),
});
