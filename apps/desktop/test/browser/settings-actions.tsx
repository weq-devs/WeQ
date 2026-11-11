import { createRoot } from 'react-dom/client';
import { Download, RotateCcw, Save, Trash2 } from 'lucide-react';
import { Card, Row } from '../../src/renderer/src/components/settings/controls';
import { BackupSection, backupApi } from '../../src/renderer/src/components/settings/BackupSection';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/im-template/styles.css';
import '../../src/renderer/src/styles/model-settings.css';
import '../../src/renderer/src/styles/backup.css';

ensureThemeInitialized();
Object.assign(window, { settingsActionsQa: useThemeStore });

createRoot(document.getElementById('root')!).render(
  <>
    <style>{`
      html,body,#root{height:auto;min-height:100%;margin:0;overflow:auto}
      .settings-actions-fixture{padding:20px;max-width:1000px;margin:auto;background:var(--weq-chat-bg);color:var(--weq-fg-primary)}
      .settings-actions-fixture p{margin:0;font-size:12px;line-height:1.6;color:var(--weq-fg-secondary)}
    `}</style>
    <main className="settings-actions-fixture">
      <div className="weq-set">
        <Card title="模型">
          <Row
            label="本地模型资源"
            desc="模型资源全局共享，当前账号单独选择画像使用的模型。"
            control={
              <select className="weq-set-input" aria-label="互动画像本地模型资源">
                <option>自动（自研模型优先） · 未就绪</option>
              </select>
            }
          />
          <button type="button" className="weq-set-btn weq-set-btn-soft" data-download>
            <Download size={14} />
            下载画像模型
          </button>
        </Card>
        <div data-backup>
          <BackupSection
            api={{
              ...backupApi,
              inventory: async () => ({
                accounts: [],
                cloneScopes: [],
                restore: { pending: null, result: null },
                canPickFile: true,
                canRestart: false,
                maxArchiveBytes: 260 * 1024 * 1024,
                chunkBytes: 65536,
              }),
            }}
          />
        </div>
        <Card title="高级设置">
          <form className="weq-intent-tuning-form" onSubmit={(event) => event.preventDefault()}>
            <input className="weq-set-input" aria-label="配置名称" defaultValue="当前配置" />
            <button type="submit" className="weq-set-btn" data-save>
              <Save size={14} />
              保存
            </button>
          </form>
          <div className="weq-set-btn-group" data-actions>
            <button type="button" className="weq-set-btn weq-set-btn-soft">
              <Download size={14} />
              下载模型
            </button>
            <button type="button" className="weq-set-btn weq-set-btn-soft" disabled>
              <Download size={14} />
              下载中…
            </button>
            <button type="button" className="weq-set-btn weq-set-btn-danger">
              <Trash2 size={14} />
              清理缓存
            </button>
            <button type="button" className="weq-set-btn weq-set-btn-soft">
              <RotateCcw size={14} />
              恢复默认配置并重新加载资源
            </button>
          </div>
        </Card>
      </div>
    </main>
  </>,
);
