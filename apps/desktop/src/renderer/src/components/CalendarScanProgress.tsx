export interface CalendarSourceProgress {
  completedSources: number;
  totalSources: number;
}
export function CalendarScanProgress({
  progress,
  dayProgress,
  day,
}: {
  progress?: CalendarSourceProgress;
  dayProgress?: CalendarSourceProgress;
  day: string;
}) {
  return (
    <div className="weq-overview-calendar-progress" role="group" aria-label="统计进度">
      {[
        { label: '本月日期来源', value: progress },
        { label: `${day} 来源`, value: dayProgress },
      ].map(({ label, value }) => (
        <section key={label}>
          <div>
            <span>{label}</span>
            <strong>
              {value ? `${value.completedSources} / ${value.totalSources}` : '准备中'}
            </strong>
          </div>
          <progress
            aria-label={label}
            aria-valuetext={
              value
                ? `已完成 ${value.completedSources} / ${value.totalSources} 个来源统计`
                : '准备中'
            }
            max={Math.max(1, value?.totalSources ?? 1)}
            value={value ? (value.totalSources === 0 ? 1 : value.completedSources) : undefined}
          />
        </section>
      ))}
    </div>
  );
}
