// 文件扩展名 → 闪传类型码映射。typeCode 用于 0x93cf f3,formatCode 用于
// 0x93d0 commit f7 与 0x12a9 filesetWrap.f7(两者同值)。mp4 → 2,rar/zip → 4。
// 未知扩展名按媒体类处理(formatCode=2),服务端按文件名扩展名判定。

export interface FlashFileTypeCode {
  typeCode: number;
  formatCode: number;
}

export function fileTypeCode(fileName: string): FlashFileTypeCode {
  const ext = fileName.toLowerCase().match(/\.([^.]+)$/)?.[1] ?? '';
  switch (ext) {
    case 'rar':
      return { typeCode: 2, formatCode: 4 };
    case 'zip':
      return { typeCode: 6, formatCode: 4 };
    case '7z':
    case 'gz':
    case 'tar':
    case 'bz2':
      return { typeCode: 2, formatCode: 4 };
    default:
      return { typeCode: 7, formatCode: 2 };
  }
}
