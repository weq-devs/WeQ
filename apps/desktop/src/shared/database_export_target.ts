/** 数据库工具的导出快照；路径只作为当前来源库清单的标识，不授予任意文件访问。 */
export interface DatabaseExportTarget {
  readonly expectedAccountUin: string;
  readonly expectedAccountConfigId: string;
  readonly dbPaths: readonly string[];
}

export function createDatabaseExportTarget(
  source: Pick<DatabaseExportTarget, 'expectedAccountUin' | 'expectedAccountConfigId'>,
  dbPaths: readonly string[],
): DatabaseExportTarget {
  if (!source.expectedAccountUin || !source.expectedAccountConfigId)
    throw new Error('数据库导出来源尚未就绪');
  if (!dbPaths.length || dbPaths.some((path) => !path)) throw new Error('请明确选择要导出的数据库');
  return Object.freeze({
    expectedAccountUin: source.expectedAccountUin,
    expectedAccountConfigId: source.expectedAccountConfigId,
    dbPaths: Object.freeze([...new Set(dbPaths)]),
  });
}

export function databaseExportTargetMatches(
  target: DatabaseExportTarget,
  source: Pick<DatabaseExportTarget, 'expectedAccountUin' | 'expectedAccountConfigId'> | null,
): boolean {
  return Boolean(
    source &&
      target.expectedAccountUin === source.expectedAccountUin &&
      target.expectedAccountConfigId === source.expectedAccountConfigId,
  );
}
