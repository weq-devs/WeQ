// 文件名/扩展名 → 闪传类型码映射。
//
// typeCode 用于 0x93cf.f3（fileset 总类型）；formatCode 用于
// 0x93d0.commitInfo.f7 与 0x12a9 filesetWrap.f7（单文件类型）。
//
// formatCode 映射依据 QQ 闪传真实 0x93d0 抓包：
//   1 音频, 2 视频, 3 Word, 4 压缩包, 5 APK, 6 Excel,
//   7 PowerPoint, 9 PDF, 10 纯文本, 11 unknown, 12 PSD,
//   16 字体, 17 IPA, 18 Keynote, 20 Numbers, 21 Pages,
//   22 Sketch, 23 DMG, 24 PKG, 25 文件夹, 26 PNG/图片。
//
// 注意：目录不能仅靠扩展名判断。当前 fileTypeCode API 只接收文件名，
// 因此目录类型 25 需要调用方在识别到目录时单独传入/处理；不能把所有
// 无扩展名普通文件都误判为目录。

export interface FlashFileTypeCode {
  typeCode: number;
  formatCode: number;
}

const FORMAT_CODE_UNKNOWN = 11;
const FORMAT_CODE_FOLDER = 25;

const FORMAT_CODE_BY_EXTENSION: Record<string, number> = {
  // 音频
  '.mp3': 1,
  '.wav': 1,
  '.flac': 1,
  '.m4a': 1,
  '.aac': 1,
  '.ogg': 1,

  // 视频
  '.mp4': 2,
  '.mov': 2,
  '.avi': 2,
  '.mkv': 2,
  '.webm': 2,
  '.flv': 2,

  // Word / 文档
  '.doc': 3,
  '.docx': 3,

  // 压缩包
  '.rar': 4,
  '.zip': 4,
  '.7z': 4,
  '.gz': 4,
  '.tar': 4,
  '.bz2': 4,

  // Android
  '.apk': 5,

  // Excel
  '.xls': 6,
  '.xlsx': 6,

  // PowerPoint
  '.ppt': 7,
  '.pptx': 7,

  // PDF / 纯文本
  '.pdf': 9,
  '.txt': 10,

  // 图片：本次抓包确认 PNG=26；其他常见图片按同一图片类型处理。
  '.png': 26,
  '.jpg': 26,
  '.jpeg': 26,
  '.gif': 26,
  '.bmp': 26,
  '.webp': 26,

  // Photoshop
  '.psd': 12,

  // 字体 / Apple / 设计文件
  '.ttf': 16,
  '.otf': 16,
  '.ipa': 17,
  '.key': 18,
  '.numbers': 20,
  '.pages': 21,
  '.sketch': 22,

  // 安装包 / 磁盘镜像
  '.dmg': 23,
  '.pkg': 24,

  // 本次抓包中以下扩展名均落到 unknown=11：
  '.ai': FORMAT_CODE_UNKNOWN,
  '.bak': FORMAT_CODE_UNKNOWN,
  '.exe': FORMAT_CODE_UNKNOWN,
  '.md': FORMAT_CODE_UNKNOWN,
  '.py': FORMAT_CODE_UNKNOWN,
  '.unknown': FORMAT_CODE_UNKNOWN,
  '.url': FORMAT_CODE_UNKNOWN,
  '.xmind': FORMAT_CODE_UNKNOWN,
};

/**
 * 返回 fileset 总类型码和单文件 formatCode。
 *
 * 真实抓包确认：
 * - zip 的 typeCode=6，其他压缩格式的 typeCode=2；
 * - 非压缩文件沿用当前实现的 fileset typeCode=7；
 * - 未知扩展名的单文件 formatCode 应为 11，而不是旧实现的 2。
 */
export function fileTypeCode(fileName: string): FlashFileTypeCode {
  const normalized = fileName.toLowerCase();
  const ext = normalized.match(/\.([^.]+)$/)?.[1] ?? '';
  const extension = ext ? `.${ext}` : '';
  const formatCode = FORMAT_CODE_BY_EXTENSION[extension] ?? FORMAT_CODE_UNKNOWN;

  if (formatCode === 4) {
    return {
      typeCode: ext === 'zip' ? 6 : 2,
      formatCode,
    };
  }

  return {
    typeCode: 7,
    formatCode,
  };
}

/** 文件夹的 formatCode。目录判断必须由调用方基于 fs.stat/isDirectory() 完成。 */
export const FLASH_FOLDER_FORMAT_CODE = FORMAT_CODE_FOLDER;
