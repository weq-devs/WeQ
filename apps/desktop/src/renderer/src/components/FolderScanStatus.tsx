import { Loader2 } from 'lucide-react';
import '../styles/folder-scan.css';

export function FolderScanStatus({ count, unit }: { count: number; unit: string }) {
  return (
    <div className="weq-folder-scan-status" role="status">
      <Loader2 size={15} className="weq-spin" aria-hidden />
      <span>
        扫描中 · 已发现 {count} {unit}
      </span>
    </div>
  );
}
