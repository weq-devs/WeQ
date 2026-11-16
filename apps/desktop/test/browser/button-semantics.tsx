import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Save, X, RefreshCw, Trash2 } from 'lucide-react';
import { DatabaseManagementSection } from '../../src/renderer/src/components/settings/DatabaseManagementSection';
import { Card, Row, Toggle } from '../../src/renderer/src/components/settings/controls';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import { useViewState } from '../../src/renderer/src/state/view';
import '../../src/renderer/src/lib/inputModality';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/styles/backup.css';

ensureThemeInitialized();
useViewState.setState({ openedUin: '10001' });
Object.assign(window, { buttonTheme: useThemeStore });

function View() {
  const [enabled, setEnabled] = useState(true);
  const [saved, setSaved] = useState(false);
  return (
    <main
      style={{ width: 'min(100%, 840px)', margin: '0 auto', padding: 16, boxSizing: 'border-box' }}
    >
      <DatabaseManagementSection onOpen={() => {}} />
      <div className="weq-set weq-backup" data-testid="form">
        <Card title="导出设置">
          <Row
            label="包含媒体"
            control={<Toggle label="包含媒体" checked={enabled} onChange={setEnabled} />}
          />
          <div className="weq-set-actions" style={{ flexWrap: 'wrap' }}>
            <button type="button" className="weq-set-btn" data-testid="retry">
              <RefreshCw size={14} />
              重新检测
            </button>
            <button
              type="button"
              className="weq-set-btn weq-set-btn-soft"
              data-testid="cancel"
              onClick={() => setSaved(false)}
            >
              <X size={14} />
              取消
            </button>
            <button
              type="button"
              className="weq-set-btn weq-set-btn-primary"
              data-testid="save"
              onClick={() => setSaved(true)}
            >
              <Save size={14} />
              {saved ? '已保存' : '保存设置'}
            </button>
            <button
              type="button"
              className="weq-set-btn weq-set-btn-primary"
              disabled
              data-testid="disabled"
            >
              保存中…
            </button>
          </div>
          <div className="weq-set-actions" style={{ flexWrap: 'wrap' }}>
            <button
              type="button"
              className="weq-set-btn"
              data-danger="outline"
              data-testid="danger-outline"
            >
              <Trash2 size={14} />
              删除配置
            </button>
            <button
              type="button"
              className="weq-set-btn"
              data-danger="solid"
              data-testid="danger-solid"
            >
              <Trash2 size={14} />
              永久删除记录
            </button>
          </div>
        </Card>
      </div>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<View />);
