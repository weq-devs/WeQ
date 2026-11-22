import type { RoamingJobStatus } from '@weq/service';

export const isRoamingJobComplete = (status: RoamingJobStatus): boolean =>
  status === 'completed' || status === 'partial';

export function roamingJobProgress(job: {
  status: RoamingJobStatus;
  plannedSeqs: number;
  pendingSeqs: number;
  planning?: { startImmediately: boolean };
  targets: readonly unknown[];
  options: { targets: readonly unknown[] };
}): number | undefined {
  if (job.planning && job.options.targets.length)
    return (100 * job.targets.length) / job.options.targets.length;
  if (isRoamingJobComplete(job.status)) return 100;
  if (!job.plannedSeqs) return undefined;
  const checked = job.plannedSeqs - job.pendingSeqs;
  return Math.min(99, Math.max(0, Math.floor((checked / job.plannedSeqs) * 100)));
}
