import { createRoot } from 'react-dom/client';
import { Trash2 } from 'lucide-react';
import { DialogHost, useDialog } from '../../src/renderer/src/components/Dialog';
import { ClearReadRecordsSetting } from '../../src/renderer/src/components/settings/ClearReadRecordsSetting';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/styles/component-appearance.css';
import '../../src/renderer/src/styles/backup.css';
import '../../src/renderer/src/styles/cache.css';

ensureThemeInitialized();
Object.assign(window, { dangerActionsQa: useThemeStore });
createRoot(document.getElementById('root')!).render(
  <>
    <style>{`
      html,body,#root{min-height:100%;margin:0;overflow:auto}
      body{background:var(--weq-bg-surface);color:var(--weq-fg-primary)}
      main{max-width:760px;margin:0 auto;padding:24px}
      .danger-fixture-row{display:flex;flex-wrap:wrap;gap:12px;margin:16px 0}
    `}</style>
    <main>
      <div className="weq-set">
        <ClearReadRecordsSetting />
      </div>
      <div className="danger-fixture-row">
        <button
          type="button"
          className="weq-set-btn"
          data-danger="solid"
          onClick={() =>
            void useDialog.getState().confirm('恢复全局默认设置？', '合成内容', {
              danger: 'solid',
              okLabel: '确认恢复默认',
            })
          }
        >
          恢复全局默认设置
        </button>
        <button type="button" className="weq-set-btn weq-set-btn-danger" data-legacy>
          普通缓存清理
        </button>
        <button type="button" className="weq-set-btn" data-normal>
          继续导出
        </button>
      </div>
      <div className="danger-fixture-row weq-dialog-foot">
        <button type="button" className="weq-action-primary" data-danger="outline">
          局部恢复默认
        </button>
        <button type="button" className="weq-action-primary" data-danger="solid">
          永久删除原件
        </button>
        <button type="button" className="weq-action-soft">
          取消
        </button>
      </div>
      <div className="danger-fixture-row">
        <button
          type="button"
          className="weq-set-iconbtn"
          data-danger="outline"
          aria-label="删除单项"
        >
          <Trash2 size={16} />
        </button>
        <button type="button" className="weq-clean-go is-danger" data-danger="outline">
          清理可再生缓存
        </button>
        <button type="button" className="weq-clean-go is-danger" data-danger="solid">
          清理不可再生媒体
        </button>
      </div>
      <div className="danger-fixture-row">
        <button type="button" className="weq-set-btn" data-danger="outline" disabled>
          禁用局部恢复
        </button>
        <button type="button" className="weq-set-btn" data-danger="solid" disabled>
          禁用全局恢复
        </button>
      </div>
    </main>
    <DialogHost />
  </>,
);
