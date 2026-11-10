/**
 * 文件传输灰条 (GRAY_TIP subType=10 / GrayTipSubType.FILE).
 *
 * QQ writes this as a separate row alongside the real FILE message once a
 * transfer finishes — either a file received from the peer or one we uploaded.
 * The row itself carries no direction marker, so the wording stays neutral.
 * Structurally it is a FILE element in an elementType=8 wrapper: it has
 * `fileName`/`fileSize`/`fileToken` and no gray-tip fields at all.
 */

import { formatBytes } from '../lib/format';

interface GrayTipFileRecvMessageProps {
  element: {
    type: 'grayTipFileRecv';
    data?: {
      fileName?: string;
      fileSize?: number;
    };
  };
}

export function GrayTipFileRecvMessage({ element }: GrayTipFileRecvMessageProps) {
  const { fileName, fileSize } = element.data || {};
  if (!fileName) return null;

  const size = fileSize ? formatBytes(fileSize) : '';

  return (
    <div className="weq-graytip text-center text-xs py-2">
      <span>文件传输完成 </span>
      <span className="weq-graytip-accent">{fileName}</span>
      {size ? <span className="px-1">({size})</span> : null}
    </div>
  );
}
