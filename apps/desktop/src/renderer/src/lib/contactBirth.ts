import {
  birthdayMonthDay,
  cachedConstellation,
  constellationFromBirthday,
  daysInBirthMonth,
  type Constellation,
} from './contactConstellation';

export type BirthProfile = {
  age?: number;
  birthYear?: number;
  birthMonth?: number;
  birthDay?: number;
  extInfo?: { constellation?: number } | null;
};

export interface BirthRange {
  year: number | null;
  /** 月日编码；不是补写的出生日期。 */
  start: number;
  end: number;
}

type BirthReference = { year: number; monthDay: number };

const calendar = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

let cachedReference: { day: number; value: BirthReference } | undefined;

export function birthReference(now = new Date()): BirthReference {
  const day = Math.floor((now.getTime() + 8 * 60 * 60 * 1000) / 86400000);
  if (cachedReference?.day === day) return cachedReference.value;
  const parts = calendar.formatToParts(now);
  const part = (type: string) => Number(parts.find((item) => item.type === type)!.value);
  const value = { year: part('year'), monthDay: part('month') * 100 + part('day') };
  cachedReference = { day, value };
  return value;
}

export function contactBirth(profile: BirthProfile, now: Date | BirthReference = new Date()) {
  const reference = now instanceof Date ? birthReference(now) : now;
  const { year: todayYear, monthDay: todayMonthDay } = reference;
  const { birthYear: year, birthMonth: month, birthDay: day } = profile;
  const validYear = Number.isInteger(year) && year! >= 1900 && year! <= 9999;
  const validMonth = Number.isInteger(month) && month! >= 1 && month! <= 12;
  const maxDay = validMonth
    ? new Date(Date.UTC(validYear ? year! : 2000, month!, 0)).getUTCDate()
    : 0;
  const validDay = Number.isInteger(day) && day! >= 1 && day! <= maxDay;
  const monthDay = validMonth && validDay ? month! * 100 + day! : null;
  const date = validYear && monthDay !== null ? year! * 10000 + monthDay : null;
  const confirmedDate = date !== null && date <= todayYear * 10000 + todayMonthDay ? date : null;
  const rawAge = profile.age;
  const age =
    Number.isInteger(rawAge) && rawAge! > 0
      ? rawAge!
      : confirmedDate !== null
        ? todayYear - year! - Number(todayMonthDay < monthDay!)
        : null;
  // 仅作排序占位，严格位于该年真实日期两侧，不补写缺失的生日月日。
  const yearOrder =
    validYear && year! <= todayYear && monthDay === null
      ? -(year! * 10000 + (age !== null && year === todayYear - age - 1 ? 1232 : 100))
      : null;
  const legacyAgeOrder =
    confirmedDate !== null
      ? -confirmedDate
      : (yearOrder ?? (age !== null ? -((todayYear - age) * 10000 + todayMonthDay) : null));
  const cached = cachedConstellation(profile.extInfo?.constellation);
  const ranges =
    monthDay === null && cached
      ? inferRanges(profile, validYear ? year! : null, age, cached, reference)
      : [];
  const inference =
    monthDay !== null || !cached
      ? 'none'
      : ranges.length === 0
        ? 'conflict'
        : ranges.length === 1 && ranges[0]!.start === ranges[0]!.end
          ? 'exact'
          : 'range';
  const first = ranges[0];
  const inferredYear =
    !validYear &&
    first?.year !== null &&
    first?.year !== undefined &&
    ranges.every((range) => range.year === first.year)
      ? first.year
      : null;
  return {
    year: validYear ? year! : null,
    month: validMonth ? month! : null,
    day: validDay ? day! : null,
    age,
    legacyAgeOrder,
    ageOrder: first?.year != null ? -(first.year * 10000 + first.start) : legacyAgeOrder,
    birthdayOrder: first
      ? Math.min(...ranges.map((range) => range.start))
      : birthdayMonthDay(month, day),
    constellation: (monthDay !== null ? constellationFromBirthday(month, day) : null) ?? cached,
    inference,
    ranges,
    inferredYear,
    inferredDate:
      inference === 'exact' && first?.year != null ? first.year * 10000 + first.start : null,
  };
}

function inferRanges(
  profile: BirthProfile,
  year: number | null,
  age: number | null,
  constellation: Constellation,
  today: BirthReference,
) {
  if (year !== null && year > today.year) return [];
  const years: Array<number | null> =
    year !== null
      ? [year]
      : age !== null
        ? [today.year - age - 1, today.year - age].filter((y) => y >= 1900)
        : [null];
  const month =
    Number.isInteger(profile.birthMonth) && profile.birthMonth! >= 1 && profile.birthMonth! <= 12
      ? profile.birthMonth!
      : null;
  const day =
    Number.isInteger(profile.birthDay) && profile.birthDay! >= 1 && profile.birthDay! <= 31
      ? profile.birthDay!
      : null;
  const ranges: BirthRange[] = [];
  // 按月切分后求交，最多处理两个年份的星座区段，不枚举全年日期。
  for (const y of years) {
    for (const [start, end] of constellation.ranges) {
      for (let m = Math.floor(start / 100); m <= Math.floor(end / 100); m++) {
        if (month !== null && m !== month) continue;
        let low = Math.max(start, m * 100 + (day ?? 1));
        let high = Math.min(
          end,
          m * 100 + (day ?? daysInBirthMonth(y ?? 2000, m)),
          m * 100 + daysInBirthMonth(y ?? 2000, m),
        );
        if (y === today.year) high = Math.min(high, today.monthDay);
        if (y !== null && age !== null) {
          if (y === today.year - age) high = Math.min(high, today.monthDay);
          else if (y === today.year - age - 1) low = Math.max(low, today.monthDay + 1);
          else continue;
        }
        if (low > high) continue;
        const previous = ranges.at(-1);
        const nextDay =
          previous &&
          new Date(
            Date.UTC(y ?? 2000, Math.floor(previous.end / 100) - 1, (previous.end % 100) + 1),
          );
        if (
          previous?.year === y &&
          nextDay &&
          nextDay.getUTCMonth() * 100 + 100 + nextDay.getUTCDate() === low
        )
          previous.end = high;
        else ranges.push({ year: y, start: low, end: high });
      }
    }
  }
  return ranges;
}

export type ContactBirth = ReturnType<typeof contactBirth>;

function monthDayText(value: number) {
  return `${Math.floor(value / 100)} 月 ${value % 100} 日`;
}

export function birthRangeText(birth: ContactBirth) {
  if (birth.inference === 'conflict') return '星座与现有生日或年龄资料不一致，未采用推断结果';
  if (!birth.ranges.length) return null;
  return `${birth.inference === 'exact' ? '推断生日' : '候选生日'}：${birth.ranges
    .map((range) => {
      const prefix = range.year === null ? '' : `${range.year} 年 `;
      return `${prefix}${monthDayText(range.start)}${range.start === range.end ? '' : `至${monthDayText(range.end)}`}`;
    })
    .join('；')}`;
}

export function contactBirthdayText(birth: ContactBirth) {
  if (birth.inference === 'none' && birth.month !== null && birth.day !== null)
    return `${birth.year ? `${birth.year} 年 ` : ''}${birth.month} 月 ${birth.day} 日`;
  if (!birth.constellation) return null;
  const year = birth.year ?? birth.inferredYear;
  return [
    year ? `${year} 年${birth.inferredYear !== null ? '（推断）' : ''}` : null,
    birth.constellation.name,
    '月日未记录',
  ]
    .filter(Boolean)
    .join(' · ');
}

export function contactAgeText(profile: BirthProfile) {
  return `${contactBirth(profile).age ?? '??'} 岁`;
}
