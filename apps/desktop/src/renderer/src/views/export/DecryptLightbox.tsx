/**
 * Decrypt database settings dialog.
 */

import { useState, type ReactElement } from 'react';
import { FolderOpen, Loader2, ShieldCheck, Zap, X } from 'lucide-react';
import { Card, Row } from '../../components/settings/controls';
import { closeFromScrim, useEscapeToClose } from '../../im-template/template/modalUtils';
import { Segmented } from './widgets';

export type DecryptMode = 'safe' | 'fast';

export interface DecryptLightboxResult {
  outputDir: string;
  mode: DecryptMode;
}

export function DecryptLightbox({
  count,
  totalBytes,
  outputDir,
  submitting,
  onPickPath,
  onClose,
  onConfirm,
  formatBytes,
}: {
  count: number;
  totalBytes: number;
  outputDir: string | null;
  submitting?: boolean;
  onPickPath: () => Promise<string | null>;
  onClose: () => void;
  onConfirm: (result: DecryptLightboxResult) => void;
  formatBytes: (bytes: number) => string;
}): ReactElement {
  useEscapeToClose(onClose);
  const [mode, setMode] = useState<DecryptMode>('safe');
  const [path, setPath] = useState<string | null>(outputDir);
  const [pickingPath, setPickingPath] = useState(false);

  async function pickPath(): Promise<void> {
    setPickingPath(true);
    try {
      const chosen = await onPickPath();
      if (chosen) setPath(chosen);
    } finally {
      setPickingPath(false);
    }
  }

  return (
    <div className="modal-scrim weq-exp-modal-scrim" role="presentation" onMouseDown={closeFromScrim(onClose)}>
      <section className="weq-exp-dialog" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
        <header className="weq-exp-dialog-head">
          <div className="weq-exp-dialog-title">
            <strong>解密数据库</strong>
            <span>{count} 个数据库 · {formatBytes(totalBytes)}</span>
          </div>
          <button type="button" className="weq-exp-dialog-close" onClick={onClose} title="关闭">
            <X size={18} />
          </button>
        </header>

        <div className="weq-exp-dialog-body">
          <Card title="保存文件夹">
            <Row
              label={
                <span className="weq-exp-path" title={path ?? undefined}>
                  <FolderOpen size={14} aria-hidden />
                  <span className="weq-exp-path-txt">{path ?? '请选择解密后的保存目录'}</span>
                </span>
              }
              control={
                <button type="button" className="weq-exp-btn" disabled={pickingPath || submitting} onClick={() => void pickPath()}>
                  {pickingPath ? <Loader2 size={14} className="weq-exp-spin" /> : <FolderOpen size={14} />}
                  选择目录
                </button>
              }
            />
          </Card>

          <Card title="解密方式">
            <Segmented<DecryptMode>
              value={mode}
              onChange={setMode}
              options={[
                { value: 'safe', label: '安全保存', icon: <ShieldCheck size={13} /> },
                { value: 'fast', label: '快速解密', icon: <Zap size={13} /> },
              ]}
            />
            <div className="weq-exp-decrypt-note">
              {mode === 'safe'
                ? '安全保存会使用更保守的解密路径，适合 QQ 在线或数据库正在变化时使用。'
                : '快速解密速度更快；如果 QQ 正在登录该账号，解密后的数据库可能损坏。'}
            </div>
          </Card>
        </div>

        <footer className="weq-exp-dialog-foot">
          <button type="button" className="weq-exp-btn" onClick={onClose} disabled={submitting}>
            取消
          </button>
          <button
            type="button"
            className="weq-exp-btn is-primary"
            disabled={submitting || !path}
            onClick={() => {
              if (!path) return;
              onConfirm({ outputDir: path, mode });
            }}
          >
            {submitting ? <Loader2 size={15} className="weq-exp-spin" /> : null}
            开始解密
          </button>
        </footer>
      </section>
    </div>
  );
}
