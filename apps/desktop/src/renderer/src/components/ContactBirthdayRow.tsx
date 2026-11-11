import { Cake, ChevronDown } from 'lucide-react';
import { birthRangeText, contactBirthdayText, type ContactBirth } from '../lib/contactBirth';
import '../styles/contact-birth.css';

export function ContactBirthdayRow({ birth }: { birth: ContactBirth }) {
  const text = contactBirthdayText(birth);
  if (!text) return null;
  const detail = birthRangeText(birth);
  return (
    <div className="weq-profile-row weq-birth-row">
      <span className="weq-profile-row-label">
        <Cake size={13} />
        生日
      </span>
      {detail ? (
        <details className="weq-birth-details" data-privacy-sensitive>
          <summary aria-label={`生日详情：${text}`}>
            <span>{text}</span>
            <ChevronDown size={13} />
          </summary>
          <p>{detail}</p>
        </details>
      ) : (
        <strong data-privacy-sensitive>{text}</strong>
      )}
    </div>
  );
}
