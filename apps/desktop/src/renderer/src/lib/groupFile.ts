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
    md: 'txt.png',
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

/** 人类可读文件大小。 */
export function formatSize(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** i;
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

/** 秒级时间戳 → `YYYY-MM-DD HH:mm`（0/空留空）。 */
export function formatFileTime(seconds: number): string {
  if (!seconds) return '';
  const d = new Date(seconds * 1000);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
