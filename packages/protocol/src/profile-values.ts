import { eventTimeFormatter } from '@weq/time';
/** QQ 资料职业目录，供编辑选项与缓存资料展示共用。 */
export const QQ_PROFESSIONS = [
  '计算机／互联网／通信',
  '生产／工艺／制造',
  '医疗／护理／制药',
  '金融／银行／投资／保险',
  '商业／服务业／个体经营',
  '文化／广告／传媒',
  '娱乐／艺术／表演',
  '律师／法务',
  '教育／培训',
  '公务员／行政／事业单位',
  '模特',
  '空姐',
  '学生',
  '其他职业',
].map((label, index) => ({ value: index + 1, label }));

const professions = new Map(QQ_PROFESSIONS.map(({ value, label }) => [value, label]));
// QQ 血型枚举：O 型在 AB 型之前，5 为其他，参见 https://www.kancloud.cn/qqrobot/d5dqqrobot/771588。
const bloodTypes = ['A型', 'B型', 'O型', 'AB型', '其他'];

export function profileCode(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function occupationText(value: unknown): string | null {
  const code = profileCode(value);
  return code === null ? null : (professions.get(code) ?? `职业（编号 ${code}）`);
}

export function bloodTypeText(value: unknown): string | null {
  const code = profileCode(value);
  return code === null ? null : (bloodTypes[code - 1] ?? `血型（编号 ${code}）`);
}

const animals = ['鼠', '牛', '虎', '兔', '龙', '蛇', '马', '羊', '猴', '鸡', '狗', '猪'];
export function chineseZodiacText(value: unknown): string | null {
  const code = profileCode(value);
  return code === null ? null : (animals[code - 1] ?? `生肖（编号 ${code}）`);
}

const timestamps = eventTimeFormatter;

/** profile_info_v6.24104 为 Unix 秒；拒绝毫秒值及超出四位年份的值。 */
export function profileTimeSeconds(value: unknown): number | null {
  const code = profileCode(value);
  return code !== null && code <= 253402271999 ? code : null;
}

export function profileTimeText(value: unknown): string | null {
  const seconds = profileTimeSeconds(value);
  return seconds === null ? null : timestamps.format(seconds * 1000);
}
