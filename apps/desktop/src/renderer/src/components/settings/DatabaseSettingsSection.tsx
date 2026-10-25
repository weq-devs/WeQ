import { useState } from 'react';
import { ToolSurface } from '../ToolSurface';
import { PageShell } from '../PageShell';
import { DatabaseToleranceSection } from './DatabaseToleranceSection';
import { DataMaintenanceSection, type MaintenanceTool } from './DataMaintenanceSection';

export function DatabaseSettingsSection({
  page,
  onOpen,
}: {
  page: 'repair' | 'tolerance';
  onOpen: (tool: MaintenanceTool) => void;
}) {
  const [recordsOpen, setRecordsOpen] = useState(false);
  return (
    <>
      <DatabaseToleranceSection
        page={page === 'repair' ? 'damage' : 'policy'}
        onOpenRecords={() => setRecordsOpen(true)}
      />
      {page === 'repair' ? (
        <DataMaintenanceSection title={null} onOpen={onOpen} tools={['db-repair']} />
      ) : null}
      {recordsOpen && (
        <ToolSurface title="容错记录" presentation="modal" onClose={() => setRecordsOpen(false)}>
          {(requestClose) => (
            <PageShell title="容错记录" onClose={requestClose}>
              <DatabaseToleranceSection page="status" />
            </PageShell>
          )}
        </ToolSurface>
      )}
    </>
  );
}
