import { formatPartialDate } from '@weq/time';
import { ChevronRight } from 'lucide-react';
import {
  birthRangeEndpoints,
  birthRangeText,
  contactBirthdayText,
  type BirthRange,
  type ContactBirth,
} from '../lib/contactBirth';
import { ContactRow } from './contactProfile/ContactRow';
import { NumericText } from './NumericText';
import '../styles/contact-birth.css';

function BirthRangeValue({ range, includeYear }: { range: BirthRange; includeYear: boolean }) {
  const { from, to } = birthRangeEndpoints(range, includeYear);
  return (
    <span>
      <span className="weq-birth-endpoint">
        <NumericText>{from}</NumericText>
      </span>
      {to ? (
        <span className="weq-birth-endpoint">
          至 <NumericText>{to}</NumericText>
        </span>
      ) : null}
    </span>
  );
}

export function ContactBirthdayRow({ birth }: { birth: ContactBirth }) {
  const recorded =
    birth.inference === 'none' ? contactBirthdayText(birth) : formatPartialDate(birth);
  const [firstRange] = birth.ranges;
  if (!recorded && !firstRange) return <ContactRow label="生日" />;

  if (!firstRange) {
    return (
      <ContactRow label="生日">
        <NumericText>{recorded ?? ''}</NumericText>
        {birth.inference === 'conflict' ? (
          <div className="weq-birth-note">{birthRangeText(birth)}</div>
        ) : null}
      </ContactRow>
    );
  }

  const includeYear = birth.year === null;
  return (
    <ContactRow label="生日">
      {recorded ? (
        <div>
          <NumericText>{recorded}</NumericText>
        </div>
      ) : null}
      {birth.ranges.length === 1 ? (
        <div className="weq-birth-range">
          <BirthRangeValue range={firstRange} includeYear={includeYear} />{' '}
          <span className="weq-birth-note">按星座推算</span>
        </div>
      ) : (
        <details className="weq-birth-details">
          <summary className="weq-disclosure-summary">
            <ChevronRight className="weq-disclosure-chevron" size={13} aria-hidden />
            查看可能日期
          </summary>
          <div className="weq-birth-note">按星座推算</div>
          {birth.ranges.map((range) => (
            <div key={`${range.year}-${range.start}`}>
              <BirthRangeValue range={range} includeYear={includeYear} />
            </div>
          ))}
        </details>
      )}
    </ContactRow>
  );
}
