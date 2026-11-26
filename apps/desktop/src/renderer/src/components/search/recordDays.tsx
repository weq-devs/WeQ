import { NumericText } from '../NumericText';

export function RecordDayHeading({ day }: { day: string }) {
  return (
    <h4 className="weq-record-day-heading" data-record-day={day}>
      {day ? <NumericText>{day.replaceAll('-', '/')}</NumericText> : '日期未知'}
    </h4>
  );
}
