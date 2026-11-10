type BirthProfile = {
  age?: number;
  birthYear?: number;
  birthMonth?: number;
  birthDay?: number;
};

const calendar = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function contactBirth(profile: BirthProfile, now = new Date()) {
  const parts = calendar.formatToParts(now);
  const part = (type: string) => Number(parts.find((item) => item.type === type)!.value);
  const todayYear = part('year');
  const todayMonthDay = part('month') * 100 + part('day');
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
  return {
    year: validYear ? year! : null,
    month: validMonth ? month! : null,
    day: validDay ? day! : null,
    age,
    // 无完整生日时仅用年龄落在同一排序尺度上，不将估算日期当作资料生日。
    ageOrder:
      confirmedDate !== null
        ? -confirmedDate
        : age !== null
          ? -((todayYear - age) * 10000 + todayMonthDay)
          : null,
  };
}

export function contactAgeText(profile: BirthProfile) {
  return `${contactBirth(profile).age ?? '??'} 岁`;
}
