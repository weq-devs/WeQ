import { useId, useRef, useState } from 'react';
import { Copy, ExternalLink, FolderOpen, Play, X } from 'lucide-react';
import { client } from '../trpc/client';
import type { QqDebugCopyPermissionAction } from '../../../shared/qq_debug_copy';

const PERMISSIONS = {
  screenCapture: { label: '截图 / 录屏', settings: '录屏', use: '截图' },
  microphone: { label: '麦克风 / 语音', settings: '麦克风', use: '语音通话' },
  camera: { label: '摄像头 / 视频', settings: '摄像头', use: '视频通话' },
} as const;
type Permission = keyof typeof PERMISSIONS;

export function QqDebugCopyPermissions({
  path,
  busy,
  canLaunch,
  running,
  onLaunch,
  onClose,
}: {
  path: string;
  busy: boolean;
  canLaunch: boolean;
  running: boolean;
  onLaunch: () => void;
  onClose: () => void;
}) {
  const id = useId();
  const [permission, setPermission] = useState<Permission>('screenCapture');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const locked = useRef(false);
  const selected = PERMISSIONS[permission];
  async function act(action: QqDebugCopyPermissionAction | 'copy') {
    if (locked.current || busy) return;
    locked.current = true;
    setPending(true);
    setError('');
    setNotice('');
    try {
      if (action === 'copy') await navigator.clipboard.writeText(path);
      else await client.bootstrap.qqDebugCopyPermission.mutate({ action });
      setNotice(
        action === 'copy'
          ? '已复制副本路径。'
          : action === 'reveal'
            ? '已请求在访达中显示副本。'
            : '已请求打开系统设置，副本权限仍待确认。',
      );
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      locked.current = false;
      setPending(false);
    }
  }
  return (
    <section className="weq-qq-debug-permissions" aria-label="副本权限引导">
      <div className="weq-qq-debug-permissions-head">
        <h4>副本权限</h4>
        <span>待确认</span>
      </div>
      <p className="weq-qq-debug-message">
        WeQ 无法可靠枚举原版 QQ
        或副本的全部系统授权。打开设置不会自动授予权限，请在副本中实际使用后确认。
      </p>
      <label className="weq-qq-debug-permission-select" htmlFor={id}>
        按需设置
        <select
          id={id}
          value={permission}
          disabled={busy || pending}
          onChange={(event) => {
            const value = event.target.value;
            if (value === 'screenCapture' || value === 'microphone' || value === 'camera') {
              setPermission(value);
              setError('');
              setNotice('');
            }
          }}
        >
          {Object.entries(PERMISSIONS).map(([value, item]) => (
            <option key={value} value={value}>
              {item.label}
            </option>
          ))}
        </select>
      </label>
      <ol className="weq-qq-debug-permission-steps">
        <li>
          {permission === 'screenCapture'
            ? '在「录屏与系统录音」（旧系统称「屏幕录制」）中添加并开启副本。'
            : `先在副本中尝试${selected.use}并允许系统请求，再在「${selected.settings}」中开启 QQ。未出现条目时，先回到副本触发请求。`}
          系统可能仍显示「QQ」，不显示「QQ-WeQ」。
        </li>
        {permission === 'screenCapture' && (
          <li>
            点「+」后按 ⌘⇧G，输入下方副本路径，选中 QQ-WeQ.app。若旧 QQ
            条目阻碍添加，可先移除旧条目再添加副本；原版可能需要重新授权。
          </li>
        )}
        <li>
          若提示退出并重新打开，选择「稍后」，从副本菜单退出
          QQ，再回到此处启动副本，避免系统重开到原版 QQ。
        </li>
        <li>在副本中重新尝试{selected.use}。仅启动成功不代表授权成功。</li>
      </ol>
      <p className="weq-qq-debug-permission-path">{path}</p>
      {running && (
        <p className="weq-qq-debug-message">
          副本正在运行。授权后请先从副本菜单退出 QQ，等待进程状态变为未启动；不会自动退出原版 QQ。
        </p>
      )}
      <div className="weq-qq-debug-actions">
        <button
          type="button"
          className="weq-set-btn"
          disabled={busy || pending}
          onClick={() => void act(permission)}
        >
          <ExternalLink size={14} />
          打开{selected.settings}设置
        </button>
        <button
          type="button"
          className="weq-set-btn"
          disabled={busy || pending}
          onClick={() => void act('reveal')}
        >
          <FolderOpen size={14} />
          在访达中显示副本
        </button>
        <button
          type="button"
          className="weq-set-btn"
          disabled={busy || pending}
          onClick={() => void act('copy')}
        >
          <Copy size={14} />
          复制副本路径
        </button>
        <button
          type="button"
          className="weq-set-btn"
          disabled={busy || pending || !canLaunch}
          onClick={onLaunch}
        >
          <Play size={14} />
          授权后启动副本
        </button>
        <button type="button" className="weq-set-btn" disabled={pending} onClick={onClose}>
          <X size={14} />
          稍后设置
        </button>
      </div>
      {notice && (
        <p className="weq-qq-debug-message" role="status">
          {notice}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {permission === 'screenCapture' && (
        <details className="weq-qq-debug-permission-troubleshoot">
          <summary>仍无法截图</summary>
          <p className="weq-qq-debug-message">
            先退出原版和副本，再手动运行以下命令，重新添加副本并授权。该命令也会清除原版 QQ
            的截图授权，不删除聊天数据；WeQ 不会自动执行。
          </p>
          <code>tccutil reset ScreenCapture com.tencent.qq</code>
          <p className="weq-qq-debug-message">
            副本更新或重新签名后可能需要再次授权。若仍失败，可先用 macOS 系统截图，再粘贴到 QQ。
          </p>
        </details>
      )}
    </section>
  );
}
