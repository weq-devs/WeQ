import { eventTimeFormatter } from '@weq/time';
import { formatBytes } from './format';
/**
 * 群文件的共享展示工具 —— 聊天页「群文件」卡片和导出中心的群文件灯箱共用，
 * 保证两边的类型图标 / 尺寸 / 时间格式完全一致。
 */

/** 群文件列表接口的 wire 形状（与主进程 `listGroupFiles` 返回一致）。 */
export interface GroupFileWire {
  fileId: string;
  fileName: string;
  fileSize: number;
  busId: number;
  uploadedTime: number;
  expireTime: number;
  modifiedTime: number;
  downloadedTimes: number;
  uploaderUin: number;
  uploaderName: string;
  parentDirectory: string;
}

/** 群文件目录接口的 wire 形状。 */
export interface GroupFolderWire {
  folderId: string;
  parentDirectoryId: string;
  folderName: string;
  createTime: number;
  modifiedTime: number;
  creatorUin: number;
  creatorName: string;
  totalFileCount: number;
}

/** `listGroupFiles` 单目录的返回。 */
export interface GroupFileListing {
  targetDirectory: string;
  files: GroupFileWire[];
  folders: GroupFolderWire[];
}

/** 按扩展名映射到 `resources/fileicon/` 下的图标文件名。 */
export function fileExtIcon(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    doc: 'doc.png',
    docx: 'doc.png',
    xls: 'xls.png',
    xlsx: 'xls.png',
    ppt: 'ppt.png',
    pptx: 'ppt.png',
    pdf: 'pdf.png',
    zip: 'zip.png',
    '7z': 'zip.png',
    gz: 'zip.png',
    tar: 'zip.png',
    rar: 'rar.png',
    exe: 'exe.png',
    msi: 'exe.png',
    mp3: 'audio.png',
    wav: 'audio.png',
    flac: 'audio.png',
    aac: 'audio.png',
    ogg: 'audio.png',
    m4a: 'audio.png',
    mp4: 'video.png',
    avi: 'video.png',
    mov: 'video.png',
    mkv: 'video.png',
    flv: 'video.png',
    wmv: 'video.png',
    png: 'image.png',
    jpg: 'image.png',
    jpeg: 'image.png',
    gif: 'image.png',
    webp: 'image.png',
    bmp: 'image.png',
    svg: 'image.png',
    txt: 'txt.png',
    md: 'markdown.png',
    log: 'txt.png',
    ai: 'ai.png',
    apk: 'apk.png',
    bak: 'bak.png',
    js: 'code.png',
    ts: 'code.png',
    jsx: 'code.png',
    tsx: 'code.png',
    py: 'code.png',
    java: 'code.png',
    c: 'code.png',
    cpp: 'code.png',
    cs: 'code.png',
    go: 'code.png',
    rs: 'code.png',
    html: 'code.png',
    css: 'code.png',
    dmg: 'dmg.png',
    ttf: 'font.png',
    otf: 'font.png',
    woff: 'font.png',
    woff2: 'font.png',
    ipa: 'ipa.png',
    key: 'keynote.png',
    xmind: 'mindmap.png',
    numbers: 'numbers.png',
    pages: 'pages.png',
    pkg: 'pkg.png',
    psd: 'ps.png',
    sketch: 'sketch.png',
  };
  return map[ext] ?? 'unknown.png';
}

/** 人类可读文件大小；统一走 lib/format，避免各页面精度不一致。 */
export function formatSize(bytes: number): string {
  return formatBytes(bytes);
}

const fileTimeFormatter = eventTimeFormatter;

/** 秒级时间戳 → 北京时间完整日期与时分秒（无效值留空）。 */
export function formatFileTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const d = new Date(seconds * 1000);
  return Number.isFinite(d.getTime()) ? fileTimeFormatter.format(d) : '';
}
