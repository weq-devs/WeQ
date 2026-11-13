import { ChevronDown } from 'lucide-react';
import { birthRangeText, contactBirthdayText, type ContactBirth } from '../lib/contactBirth';
import { ContactRow } from './contactProfile/ContactRow';
import '../styles/contact-birth.css';

export function ContactBirthdayRow({ birth }: { birth: ContactBirth }) {
  const text = contactBirthdayText(birth);
  if (!text) return <ContactRow label="生日" value={null} />;
  const detail = birthRangeText(birth);
  return (
    <ContactRow label="生日">
      {detail ? (
        <details className="weq-birth-details" data-privacy-sensitive>
          <summary aria-label={`生日详情：${text}`}>
            <span>{text}</span>
            <ChevronDown size={13} />
          </summary>
          <p>{detail}</p>
        </details>
      ) : (
        text
      )}
    </ContactRow>
  );
}
