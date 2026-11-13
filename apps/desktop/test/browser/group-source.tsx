import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { GroupFileDialog } from '../../src/renderer/src/components/GroupFileDialog';
import { GroupTodos } from '../../src/renderer/src/components/qq-actions/GroupActions';
import { WorkspaceContent, WorkspacePages } from '../../src/renderer/src/components/WorkspacePages';
import { useViewState } from '../../src/renderer/src/state/view';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/im-template/styles.css';
ensureThemeInitialized();
useViewState.setState({ openedUin: '99999' });
const qa = { mode: 'multiple', reads: 0, jumps: [] as string[][], theme: useThemeStore };
Object.assign(window, { groupSourceQa: qa });
function App() {
  const [files, setFiles] = useState(false);
  return (
    <WorkspacePages navigationKey="fixture">
      <WorkspaceContent>
        <button type="button" onClick={() => setFiles(true)}>
          打开群文件
        </button>
        <GroupTodos
          groupId={777}
          groupName="合成群"
          embedded
          onJumpToMessage={(seq) => qa.jumps.push([seq])}
        />
        {files && (
          <GroupFileDialog
            groupCode="777"
            groupName="合成群"
            onClose={() => setFiles(false)}
            onJumpToMessage={(seq, id) => qa.jumps.push([seq, id])}
          />
        )}
      </WorkspaceContent>
    </WorkspacePages>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
