import { decode, encode, message } from '../../protobuf';
import type { TrpcNative } from '../../transport';
import { invokeLegacyOidb } from '../legacy';
import { requireUin, responseObject } from '../write-validation';

import {
  PROFILE_DISPLAY_FIELDS,
  PROFILE_DISPLAY_KEYS,
  profileDisplayRaw,
  type ProfileDisplayField,
  type SelfProfileDisplaySettings,
} from '../../profile-display';
export * from '../../profile-display';
const uins = { name: 'uins', tag: 1, type: 'uint64' as const, repeated: true };
const fields = PROFILE_DISPLAY_KEYS.map((field) => ({
  name: field,
  tag: PROFILE_DISPLAY_FIELDS[field].tag,
  type: 'uint32' as const,
  force: true,
}));
const request = message([uins, ...fields]);
const response = message([
  {
    name: 'rows',
    tag: 11,
    type: message([{ name: 'uin', tag: 1, type: 'uint64' }, ...fields]),
    repeated: true,
  },
  { name: 'unfinished', tag: 12, type: 'uint64', repeated: true },
]);

export async function getSelfProfileDisplaySettings(
  nt: TrpcNative,
  pid: number,
  targetUin: string,
  selected: readonly ProfileDisplayField[] = PROFILE_DISPLAY_KEYS,
): Promise<SelfProfileDisplaySettings> {
  const uin = requireUin(targetUin);
  if (!selected.length || selected.some((field) => !Object.hasOwn(PROFILE_DISPLAY_FIELDS, field)))
    throw new Error('资料展示字段无效');
  const body = await invokeLegacyOidb(
    nt,
    pid,
    0x5eb,
    22,
    'OidbSvc.0x5eb_22',
    encode(request, { uins: [uin], ...Object.fromEntries(selected.map((field) => [field, 1])) }),
    { strict: true },
  );
  const result = decode(response, body, { strict: true });
  const unfinished = (result.unfinished as bigint[] | undefined) ?? [];
  const rows = ((result.rows as unknown[] | undefined) ?? []).map((row) =>
    responseObject(row, '资料展示'),
  );
  if (rows.some((row) => String(row.uin) !== targetUin) || rows.length > 1)
    throw new Error('资料展示返回目标不匹配');
  const row = rows[0];
  const incomplete = unfinished.some((value) => String(value) === targetUin);
  if (!row && !incomplete) throw new Error('资料展示响应缺少当前账号');
  return {
    targetUin,
    settings: selected.map((field) => {
      const raw = row?.[field];
      if (raw !== undefined && (typeof raw !== 'number' || !Number.isInteger(raw)))
        throw new Error('资料展示状态无效');
      const option = PROFILE_DISPLAY_FIELDS[field].options.find((option) => option.raw === raw);
      return {
        field,
        raw: typeof raw === 'number' ? raw : null,
        value: incomplete ? null : (option?.value ?? null),
        status: incomplete
          ? 'incomplete'
          : raw === undefined
            ? 'missing'
            : option
              ? 'known'
              : 'unknown',
      };
    }),
  };
}

export async function setSelfProfileDisplaySetting(
  nt: TrpcNative,
  pid: number,
  targetUin: string,
  field: ProfileDisplayField,
  value: number,
): Promise<void> {
  const uin = requireUin(targetUin);
  const raw = profileDisplayRaw(field, value);
  await invokeLegacyOidb(
    nt,
    pid,
    0x587,
    74,
    'OidbSvc.0x587_74',
    encode(request, { uins: [uin], [field]: raw }),
    { strict: true },
  );
}
