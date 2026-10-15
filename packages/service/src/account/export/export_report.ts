import type { ExportTask } from './task_manager';

export function exportReport(task: ExportTask) {
  const failures = task.stages.flatMap((stage) => stage.failures ?? []);
  const unresolved = task.stages.filter(
    (stage) =>
      stage.status === 'failed' || stage.status === 'pending' || stage.status === 'running',
  );
  return {
    schema: 'weq-export-report/1',
    taskId: task.id,
    executionStatus: task.status,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    conversation: { kind: task.kind, id: task.conv },
    formats: task.formats ?? [task.format],
    range: task.range ?? null,
    filter: task.filter ?? null,
    contentStatus:
      task.error ||
      task.stages.some((stage) => (stage.failed ?? 0) > 0) ||
      task.backfillSummary?.stoppedByError ||
      task.backfillSummary?.stoppedByEmpty ||
      task.backfillSummary?.windowErrors ||
      task.messageCoverage?.emptyMessages ||
      task.sourceChanged ||
      unresolved.length ||
      failures.length ||
      task.messageCoverage?.unknownMessages
        ? 'partial'
        : 'unverified',
    messages: {
      exported: task.current,
      byFormat: task.formatCounts ?? null,
      parsing: task.messageCoverage
        ? {
            ...task.messageCoverage,
            scope:
              'render elements and known nested messages, depth limited to 16; not a raw protobuf-field audit',
          }
        : null,
    },
    allServerHistoryVerified: false,
    source: {
      binding: task.resumeBinding ?? null,
      changedDuringExport: task.sourceChanged ?? null,
      proof: 'database-and-WAL file identity/size/mtime/ctime; not a historical snapshot',
    },
    roaming: {
      requested: !!task.media?.completeMessages,
      stage: task.stages.find((stage) => stage.key === 'backfill') ?? null,
      unresolvedIntervals: task.sequenceCoverage ?? null,
      summary: task.backfillSummary ?? null,
    },
    media: {
      requested: !!task.media?.exportMedia,
      originalQualityVerified: false,
      stages: task.stages.filter((stage) =>
        ['media', 'image', 'video', 'file', 'ptt'].includes(stage.key),
      ),
      failures,
    },
    unresolvedStages: unresolved.map((stage) => stage.key),
    error: task.error ?? null,
    // Existing specialised evidence is kept alongside this summary, not replaced.
    specialisedCoverage: task.qzone || task.collection ? 'coverage.json' : null,
  };
}
