import { decode, encode, message } from '../../protobuf';
import type { TrpcNative } from '../../transport';
import { invokeLegacyOidb } from '../legacy';
import { requireUin, responseObject } from '../write-validation';

export interface ProfileEducationRecord {
  index: number | null;
  category: number | null;
  schoolId: string | null;
  schoolName: string | null;
  departmentId: string | null;
  departmentName: string | null;
  degree: number | null;
  enrollmentYear: number | null;
  graduationYear: number | null;
  allowRecommend: number | null;
  createSource: number | null;
  createdAt: number | null;
  updateSource: number | null;
  updatedAt: number | null;
  hidden: number | null;
  verifyStatus: number | null;
  verifyType: number | null;
}
export interface ProfileEducationHistory {
  targetUin: string;
  items: ProfileEducationRecord[];
}
const uint = (name: string, tag: number) => ({ name, tag, type: 'uint32' as const });
const text = (name: string, tag: number) => ({ name, tag, type: 'string' as const });
const request = message([
  { name: 'uin', tag: 1, type: 'uint64' },
  { ...uint('category', 2), force: true },
]);
const record = message([
  uint('category', 1),
  text('schoolId', 2),
  text('schoolName', 3),
  text('departmentId', 4),
  text('departmentName', 5),
  uint('degree', 6),
  uint('enrollmentYear', 7),
  uint('graduationYear', 8),
  uint('allowRecommend', 9),
  uint('createSource', 10),
  uint('createdAt', 11),
  uint('updateSource', 12),
  uint('updatedAt', 13),
  uint('hidden', 14),
  uint('verifyStatus', 15),
  uint('verifyType', 16),
  uint('index', 100),
]);
const response = message([
  {
    name: 'history',
    tag: 1,
    type: message([{ name: 'items', tag: 1, type: record, repeated: true }]),
  },
]);
function number(value: unknown): number | null {
  if (value === undefined) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 0xffffffff)
    throw new Error('教育经历数字字段无效');
  return value;
}
function string(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string') throw new Error('教育经历文本字段无效');
  return value;
}

/** 原生详细资料页使用 serviceType=1，和 H5 的 0xd2d_2 不混用。 */
export async function getEducationHistory(
  nt: TrpcNative,
  pid: number,
  targetUin: string,
): Promise<ProfileEducationHistory> {
  const uin = requireUin(targetUin);
  const body = await invokeLegacyOidb(
    nt,
    pid,
    0xd2d,
    1,
    'OidbSvc.0xd2d',
    encode(request, { uin, category: 0 }),
    { strict: true },
  );
  const decoded = decode(response, body, { strict: true });
  // 官方在成功空响应中允许省略整个 EduHis，不将传输／业务错误降级为空列表。
  const history =
    decoded.history === undefined ? null : responseObject(decoded.history, '教育经历');
  const rows = history?.items ?? [];
  if (!Array.isArray(rows)) throw new Error('教育经历列表无效');
  return {
    targetUin,
    items: rows.map((raw): ProfileEducationRecord => {
      const row = responseObject(raw, '教育经历条目');
      return {
        index: number(row.index),
        category: number(row.category),
        schoolId: string(row.schoolId),
        schoolName: string(row.schoolName),
        departmentId: string(row.departmentId),
        departmentName: string(row.departmentName),
        degree: number(row.degree),
        enrollmentYear: number(row.enrollmentYear),
        graduationYear: number(row.graduationYear),
        allowRecommend: number(row.allowRecommend),
        createSource: number(row.createSource),
        createdAt: number(row.createdAt),
        updateSource: number(row.updateSource),
        updatedAt: number(row.updatedAt),
        hidden: number(row.hidden),
        verifyStatus: number(row.verifyStatus),
        verifyType: number(row.verifyType),
      };
    }),
  };
}
