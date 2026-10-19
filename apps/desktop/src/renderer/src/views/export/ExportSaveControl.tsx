import { FolderOpen, Loader2, RotateCcw, Save } from 'lucide-react';
import type { ExportSavePolicy } from '@weq/service';
import { IS_WEB } from '../../lib/target';
import '../../styles/export-save-control.css';

export function ExportSaveControl({
  value,
  onChange,
  onPickDirectory,
  onSetDefault,
  onReset,
  overridden = false,
  disabled = false,
  picking = false,
}: {
  value: ExportSavePolicy;
  onChange: (policy: ExportSavePolicy) => void;
  onPickDirectory: () => void;
  onSetDefault?: () => void;
  onReset?: () => void;
  overridden?: boolean;
  disabled?: boolean;
  picking?: boolean;
}) {
  return (
    <fieldset
      className="weq-export-save-control"
      disabled={disabled || picking}
      aria-busy={picking}
    >
      <legend>保存位置</legend>
      <label>
        <span>保存方式</span>
        <select
          aria-label="保存方式"
          value={value.mode}
          onChange={(event) => {
            const mode = event.target.value;
            if (mode === 'preset' || mode === 'before' || mode === 'after')
              onChange({
                mode,
                ...(mode === 'preset' && value.mode === 'preset' && value.directory
                  ? { directory: value.directory }
                  : {}),
              });
          }}
        >
          <option value="preset">使用预设目录</option>
          <option value="before">开始前选择</option>
          <option value="after">完成后选择</option>
        </select>
      </label>
      {value.mode === 'preset' ? (
        <div className="weq-export-save-location">
          <span title={value.directory}>
            {value.directory || (IS_WEB ? '服务器配置的导出目录' : '尚未设置目录')}
          </span>
          <button
            type="button"
            title="选择保存目录"
            aria-label="选择保存目录"
            onClick={onPickDirectory}
          >
            {picking ? <Loader2 size={16} /> : <FolderOpen size={16} />}
          </button>
        </div>
      ) : value.mode === 'before' && IS_WEB ? (
        <label>
          <span>服务器导出目录内的子文件夹</span>
          <input
            aria-label="服务器保存子目录"
            value={value.directory ?? ''}
            placeholder="当前导出目录"
            onChange={(event) =>
              onChange({ mode: 'before', directory: event.target.value || undefined })
            }
          />
        </label>
      ) : null}
      {IS_WEB ? (
        <span className="weq-export-save-platform">
          文件保存至服务器，浏览器下载位置由浏览器决定
        </span>
      ) : null}
      {onSetDefault || onReset ? (
        <div className="weq-export-save-actions">
          {onSetDefault ? (
            <button
              type="button"
              title="设为默认保存方式"
              aria-label="设为默认保存方式"
              onClick={onSetDefault}
            >
              <Save size={15} />
              <span>设为默认</span>
            </button>
          ) : null}
          {onReset ? (
            <button
              type="button"
              title="恢复默认保存设置"
              aria-label="恢复默认保存设置"
              disabled={!overridden}
              onClick={onReset}
            >
              <RotateCcw size={15} />
            </button>
          ) : null}
        </div>
      ) : null}
    </fieldset>
  );
}
