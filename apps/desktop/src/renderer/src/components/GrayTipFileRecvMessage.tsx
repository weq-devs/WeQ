/**
 * 文件接收灰条 (GRAY_TIP subType=10 / GrayTipSubType.FILE).
 *
 * QQ writes this as a separate row alongside the real FILE message when a file
 * from the peer finishes transferring. Structurally it is a FILE element in an
 * elementType=8 wrapper — it carries `fileName`/`fileSize`/`fileToken` and no
 * gray-tip fields at all. The sender is always the peer (verified across all
 * 259 occurrences), so it always reads as "收到文件".
 */

interface GrayTipFileRecvMessageProps {
  element: {
    type: 'grayTipFileRecv';
    data?: {
      fileName?: string;
      fileSize?: number;
    };
  };
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)}${units[unit]}`;
}

export function GrayTipFileRecvMessage({ element }: GrayTipFileRecvMessageProps) {
  const { fileName, fileSize } = element.data || {};
  if (!fileName) return null;

  const size = fileSize ? formatBytes(fileSize) : '';

  return (
    <div className="weq-graytip text-center text-gray-500 text-xs py-2">
      <span>已接收文件 </span>
      <span className="text-blue-500">{fileName}</span>
      {size ? <span className="px-1">({size})</span> : null}
    </div>
  );
}
