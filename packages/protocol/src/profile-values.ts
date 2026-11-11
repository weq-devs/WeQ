/** QQ 资料编辑器的职业目录；不代表本地 20022 缓存字段的编号映射已核实。 */
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

export function profileCode(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function occupationText(value: unknown): string | null {
  const code = profileCode(value);
  return code === null ? null : `职业（编号 ${code}）`;
}

export function bloodTypeText(value: unknown): string | null {
  const code = profileCode(value);
  return code === null ? null : `血型（编号 ${code}）`;
}

const animals = ['鼠', '牛', '虎', '兔', '龙', '蛇', '马', '羊', '猴', '鸡', '狗', '猪'];
export function chineseZodiacText(value: unknown): string | null {
  const code = profileCode(value);
  return code === null ? null : (animals[code - 1] ?? `生肖（编号 ${code}）`);
}

const timestamps = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** profile_info_v6.24104 为 Unix 秒；拒绝毫秒值及超出四位年份的值。 */
export function profileTimeSeconds(value: unknown): number | null {
  const code = profileCode(value);
  return code !== null && code <= 253402271999 ? code : null;
}

export function profileTimeText(value: unknown): string | null {
  const seconds = profileTimeSeconds(value);
  return seconds === null ? null : timestamps.format(seconds * 1000);
}
