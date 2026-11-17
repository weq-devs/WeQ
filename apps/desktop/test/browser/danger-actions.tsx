import { createRoot } from 'react-dom/client';
import { Trash2, Undo2 } from 'lucide-react';
import { DialogHost, useDialog } from '../../src/renderer/src/components/Dialog';
import { ClearReadRecordsSetting } from '../../src/renderer/src/components/settings/ClearReadRecordsSetting';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/styles/component-appearance.css';
import '../../src/renderer/src/styles/backup.css';
import '../../src/renderer/src/styles/cache.css';
import '../../src/renderer/src/styles/message-context-menu.css';
import '../../src/renderer/src/styles/conversation-actions.css';

ensureThemeInitialized();
Object.assign(window, { dangerActionsQa: useThemeStore });
createRoot(document.getElementById('root')!).render(
  <>
    <style>{`
      html,body,#root{min-height:100%;margin:0;overflow:auto}
      body{background:var(--weq-bg-surface);color:var(--weq-fg-primary)}
      main{max-width:760px;margin:0 auto;padding:24px}
      .danger-fixture-row{display:flex;flex-wrap:wrap;gap:12px;margin:16px 0}
      .danger-fixture-row>.message-context-menu{position:static}
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
      <div className="danger-fixture-row">
        <div className="message-menu-v2 message-context-menu">
          <div className="message-menu-group">
            <button type="button" data-danger="outline">
              <Undo2 /> <span>撤回</span>
            </button>
            <button type="button" data-danger="outline">
              <Trash2 /> <span>本地删除</span>
            </button>
          </div>
        </div>
        <div className="weq-conversation-actions-menu">
          <button type="button" data-danger="solid">
            <Trash2 size={16} /> <span>永久删除克隆会话</span>
          </button>
          <button type="button" data-danger="solid">
            <Trash2 size={16} /> <span>永久删除助手会话</span>
          </button>
          <button type="button" data-danger="solid" disabled data-menu-disabled>
            <Trash2 size={16} /> <span>正在删除会话</span>
          </button>
        </div>
      </div>
    </main>
    <DialogHost />
  </>,
);
