import type { ProfileEducationRecord } from '@weq/protocol';

// Android QQ getDegreeName 的完整映射（2、3 均为中学）；H5 仅提供 5–9。
const degrees: Record<number, string> = {
  1: '小学',
  2: '中学',
  3: '中学',
  4: '中专',
  5: '大专',
  6: '本科',
  7: '研究生',
  8: '博士',
  9: '博士后',
};
export function educationDegree(value: number | null): string | null {
  return value === null || value === 0 ? null : (degrees[value] ?? `学历编号 ${value}`);
}
export function educationYears(record: ProfileEducationRecord): string | null {
  return (
    [
      record.enrollmentYear ? `${record.enrollmentYear} 年入学` : '',
      record.graduationYear ? `${record.graduationYear} 年毕业` : '',
    ]
      .filter(Boolean)
      .join(' · ') || null
  );
}
export function educationRows(records: ProfileEducationRecord[], self: boolean) {
  const occurrences = new Map<string, number>();
  return records
    .filter((record) => self || record.hidden !== 1)
    .map((record) => {
      // 老记录可能缺少 idx，同校记录也可重复；不因 React key 合并或丢弃记录。
      const identity = record.index === null ? JSON.stringify(record) : `idx:${record.index}`;
      const occurrence = occurrences.get(identity) ?? 0;
      occurrences.set(identity, occurrence + 1);
      return { key: `${identity}:${occurrence}`, record };
    });
}
