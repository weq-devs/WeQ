const visibility = [
  { value: 0, label: '所有人', title: '所有人可见', raw: 0 },
  { value: 1, label: '仅好友', title: '仅好友可见', raw: 1 },
  { value: 2, label: '不可见', title: '所有人不可见', raw: 2 },
] as const;
const display = [
  { value: 0, label: '展示', title: '展示此项', raw: 0 },
  { value: 1, label: '隐藏', title: '隐藏此项', raw: 1 },
] as const;

/** Android FieldMap 与消费端的对应关系，不按页面中文名称猜字段。 */
export const PROFILE_DISPLAY_FIELDS = {
  gender: { tag: 41611, label: '性别', options: visibility },
  age: { tag: 41610, label: '年龄', options: visibility },
  birthday: { tag: 41607, label: '生日', options: visibility },
  constellation: { tag: 41609, label: '星座', options: visibility },
  profession: { tag: 41618, label: '职业', options: visibility },
  company: { tag: 40272, label: '公司', options: visibility },
  education: { tag: 41619, label: '教育经历', options: visibility },
  region: { tag: 41614, label: '所在地', options: visibility },
  hometown: { tag: 41613, label: '家乡', options: visibility },
  email: { tag: 41622, label: '邮箱', options: visibility },
  personalNote: { tag: 41623, label: '个人说明', options: visibility },
  personalityLabels: { tag: 42128, label: '标签相册', options: display },
  anonymousQuestions: { tag: 42425, label: '匿问我答', options: display },
  // 两项独立枚举不暴露为通用 bool；目前资料页没有对应正文，不挂载控件。
  qqCub: {
    tag: 47184,
    label: 'Q 崽',
    options: [
      { value: 0, label: '隐藏', title: '隐藏 Q 崽', raw: 1 },
      { value: 1, label: '展示', title: '展示 Q 崽', raw: 2 },
    ],
  },
  metaFarm: {
    tag: 47201,
    label: '农场',
    options: [
      { value: 0, label: '隐藏', title: '隐藏农场', raw: 2 },
      { value: 1, label: '展示', title: '展示农场', raw: 1 },
    ],
  },
} as const;
export type ProfileDisplayField = keyof typeof PROFILE_DISPLAY_FIELDS;
export const PROFILE_DISPLAY_KEYS = Object.keys(PROFILE_DISPLAY_FIELDS) as ProfileDisplayField[];
export interface ProfileDisplaySetting {
  field: ProfileDisplayField;
  raw: number | null;
  value: number | null;
  status: 'known' | 'missing' | 'unknown' | 'incomplete';
}
export interface SelfProfileDisplaySettings {
  targetUin: string;
  settings: ProfileDisplaySetting[];
}
export function profileDisplayRaw(field: ProfileDisplayField, value: number): number {
  const definition = Object.hasOwn(PROFILE_DISPLAY_FIELDS, field)
    ? PROFILE_DISPLAY_FIELDS[field]
    : undefined;
  const option = definition?.options.find((option) => option.value === value);
  if (!option) throw new Error('资料展示选项无效');
  return option.raw;
}
