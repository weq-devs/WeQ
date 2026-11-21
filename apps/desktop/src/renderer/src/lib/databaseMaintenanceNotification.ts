import {
  databaseMaintenanceKindLabel,
  databaseMaintenanceRowAbnormal,
  type DatabaseMaintenanceSnapshot,
} from '@weq/service/db-checkup';

/** 执行结果与诊断分别表达，查看目标始终绑定原报告，不携带重新检查动作。 */
export function databaseMaintenanceNotification(snapshot: DatabaseMaintenanceSnapshot) {
  const op = snapshot.operation;
  if (!op) return null;
  const account = {
    uin: snapshot.uin,
    configId: snapshot.configId,
    reportId: op.id,
    name: snapshot.uin,
    avatarUrl: '',
  };
  if (snapshot.maintenanceError)
    return {
      key: `database-maintenance-lost:${snapshot.id}`,
      event: 'databaseDamage' as const,
      tone: 'error' as const,
      loading: false,
      title: '数据库维护已中断',
      detail: snapshot.maintenanceError,
      account,
    };
  if (op.status === 'running')
    return op.kind !== 'repair'
      ? null
      : {
          key: `database-maintenance-progress:${snapshot.id}`,
          event: 'progress' as const,
          tone: 'info' as const,
          loading: true,
          title: '正在修复数据库',
          summary: `${op.completedDatabases} / ${op.totalDatabases} 个数据库已完成`,
          detail: [op.currentDb, snapshot.progress?.current?.message].filter(Boolean).join('\n'),
          account: { ...account, reportId: undefined },
        };
  const abnormal = snapshot.databases.filter(databaseMaintenanceRowAbnormal).length;
  const failed = ['failed', 'partial', 'interrupted', 'waiting'].includes(op.status);
  if (op.kind !== 'repair' && (op.status === 'cancelled' || (!failed && !abnormal))) return null;
  return {
    key: `database-maintenance:${op.id}`,
    event:
      op.kind !== 'repair'
        ? ('databaseDamage' as const)
        : failed
          ? ('taskFailure' as const)
          : op.status === 'cancelled'
            ? ('success' as const)
            : ('taskComplete' as const),
    tone: failed
      ? ('error' as const)
      : op.kind === 'repair'
        ? op.status === 'cancelled'
          ? ('info' as const)
          : ('success' as const)
        : ('warning' as const),
    title:
      op.status === 'waiting'
        ? '数据库修复等待处理'
        : `${databaseMaintenanceKindLabel[op.kind]}${failed ? (op.status === 'partial' ? '部分完成' : '未完成') : op.status === 'cancelled' ? '已停止' : op.kind === 'repair' ? '已完成' : '已完成，发现数据库异常'}`,
    loading: false,
    summary:
      op.kind !== 'repair' && abnormal
        ? `${abnormal} 个数据库发现异常`
        : `${op.completedDatabases} / ${op.totalDatabases} 个数据库已完成`,
    detail: [
      op.error,
      ...snapshot.databases.flatMap((row) =>
        row.repair?.error
          ? [`${row.dbName}：${row.repair.error}`]
          : row.scanError
            ? [`${row.dbName}：${row.scanError}`]
            : [],
      ),
      op.kind === 'repair' && op.status === 'cancelled'
        ? '已成功修复的数据库保持不变，未继续启动后续数据库。'
        : undefined,
    ]
      .filter(Boolean)
      .join('\n'),
    account: op.status === 'waiting' ? { ...account, reportId: undefined } : account,
  };
}
