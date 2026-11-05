import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { FileUp } from 'lucide-react';
import { pickAccountFile } from '../../src/renderer/src/lib/accountFilePicker';
import { WebNotificationsSection } from '../../src/renderer/src/components/settings/WebNotificationsSection';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import { useViewState } from '../../src/renderer/src/state/view';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/im-template/styles.css';

ensureThemeInitialized();
useViewState.setState({ openedUin: '10001' });
Object.assign(window, { webParityQa: useThemeStore });
function Fixture() {
  const [result, setResult] = useState('');
  return (
    <main
      className="weq-set"
      style={{
        padding: 16,
        maxWidth: 720,
        margin: 'auto',
        minHeight: '100vh',
        alignContent: 'start',
        background: 'var(--weq-chat-bg)',
      }}
    >
      <WebNotificationsSection />
      <button
        className="weq-set-btn"
        type="button"
        onClick={() => {
          void pickAccountFile('file')
            .then((file) => setResult(file?.fileName ?? '已取消'))
            .catch((error: unknown) => setResult(String(error)));
        }}
      >
        <FileUp size={16} />
        选择文件
      </button>
      <output data-result>{result}</output>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
