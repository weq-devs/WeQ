/** 群文件 / 文件夹 / 私聊文件的列表与下载地址。 */
export { ListGroupFiles } from './list-group-files';
export type { GroupFileItem, GroupFolderItem, GroupFilePage } from './list-group-files';
export {
  GetGroupFileUrl,
  GetPrivateFileUrl,
  composeGroupFileDownloadUrl,
} from './get-file-url';
export type { GroupFileDownload } from './get-file-url';
export { GetGroupPttUrl, GetPrivatePttUrl } from './get-ptt-url';
export { GetGroupVideoUrl, GetPrivateVideoUrl } from './get-video-url';

export {
  DeleteGroupFile,
  RenameGroupFile,
  MoveGroupFile,
  CreateGroupFolder,
  DeleteGroupFolder,
  RenameGroupFolder,
  GetGroupFileCount,
  GetGroupFileSpace,
} from './file-ops';
export type {
  DeleteGroupFileParams,
  RenameGroupFileParams,
  MoveGroupFileParams,
  CreateGroupFolderParams,
  CreatedGroupFolder,
  DeleteGroupFolderParams,
  RenameGroupFolderParams,
  GroupFileCount,
  GetGroupFileCountParams,
  GroupFileSpace,
  GetGroupFileSpaceParams,
} from './file-ops';
