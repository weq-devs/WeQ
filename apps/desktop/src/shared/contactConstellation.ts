export interface Constellation {
  id: number;
  name: string;
  ranges: ReadonlyArray<readonly [number, number]>;
}

const names = [
  '水瓶座',
  '双鱼座',
  '白羊座',
  '金牛座',
  '双子座',
  '巨蟹座',
  '狮子座',
  '处女座',
  '天秤座',
  '天蝎座',
  '射手座',
  '摩羯座',
];
const cutoffs = [20, 19, 21, 20, 21, 22, 23, 23, 23, 24, 23, 22];

export function daysInBirthMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** 年度生日排序使用闰年校验，保留没有年份的 2 月 29 日。 */
export function birthdayMonthDay(month?: number, day?: number, year = 2000) {
  if (
    !Number.isInteger(month) ||
    month! < 1 ||
    month! > 12 ||
    !Number.isInteger(day) ||
    day! < 1 ||
    day! > daysInBirthMonth(year, month!)
  )
    return null;
  return month! * 100 + day!;
}

const constellations: Constellation[] = names.map((name, index) => {
  const month = index + 1;
  return {
    id: month,
    name,
    ranges:
      month === 12
        ? [
            [101, 100 + cutoffs[0]! - 1],
            [1200 + cutoffs[11]!, 1231],
          ]
        : [[month * 100 + cutoffs[index]!, (month + 1) * 100 + cutoffs[index + 1]! - 1]],
  };
});

export function cachedConstellation(id?: number) {
  return Number.isInteger(id) && id! >= 1 && id! <= 12 ? constellations[id! - 1]! : null;
}

export function constellationFromBirthday(month?: number, day?: number) {
  const value = birthdayMonthDay(month, day);
  return value === null
    ? null
    : constellations.find((item) =>
        item.ranges.some(([start, end]) => value >= start && value <= end),
      )!;
}
