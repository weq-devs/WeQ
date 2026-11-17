import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DatabaseRecoveryPanel } from '../../src/renderer/src/components/tasks/DatabaseRecoveryPanel';
import { DatabaseRepairSection } from '../../src/renderer/src/components/settings/DatabaseRepairSection';
import { useThemeStore } from '../../src/renderer/src/state/theme';
import { useViewState } from '../../src/renderer/src/state/view';
import type { ExportTask } from '@weq/service';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/styles/settings-database.css';

useViewState.setState({ openedUin: '10001' });
const calls: unknown[] = [];
function Fixture() {
  const [kind, setKind] = useState<'ranges' | 'table' | 'read'>('ranges');
  const [canSkip, setCanSkip] = useState(true);
  const request: NonNullable<ExportTask['databaseRecovery']> = {
    id: `${kind}:${canSkip}`,
    kind,
    canSkip,
    dbPath: '/fixture/同号备份/nt_msg.db',
    table: 'group_msg_table',
    ranges: kind === 'ranges' ? [{ lo: '9007199254740993', hi: '9007199254740999' }] : undefined,
  };
  Object.assign(window, { recoveryQa: { calls, setKind, setCanSkip, theme: useThemeStore } });
  return (
    <main
      className="weq-set weq-database-management"
      style={{ maxWidth: 820, padding: 16, margin: '0 auto' }}
    >
      <DatabaseRepairSection onOpen={(tool) => calls.push(tool)} />
      <DatabaseRecoveryPanel
        key={request.id}
        request={request}
        name="合成聊天记录导出"
        onDecision={async (decision, remaining) => {
          calls.push({ decision, remaining });
        }}
      />
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
