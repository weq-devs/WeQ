import { useEffect, useId, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { TabActivity, useTabActive } from '../RetainedTabs';

/** 展开后才挂载，收起保留分页和草稿，同时暂停读取。 */
export function ProfileDisclosure({
  title,
  initiallyOpen = false,
  openRequest = 0,
  children,
}: {
  title: string;
  initiallyOpen?: boolean;
  openRequest?: number;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const [visited, setVisited] = useState(initiallyOpen);
  const active = useTabActive();
  const id = useId();
  useEffect(() => {
    if (initiallyOpen) {
      setVisited(true);
      setOpen(true);
    }
  }, [initiallyOpen, openRequest]);
  return (
    <section className="weq-profile-disclosure">
      <button
        type="button"
        className="weq-profile-disclosure-trigger"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => {
          setVisited(true);
          setOpen((value) => !value);
        }}
      >
        <span>{title}</span>
        <ChevronDown size={16} aria-hidden />
      </button>
      <div id={id} hidden={!open} className="weq-profile-disclosure-body">
        {visited ? <TabActivity active={active && open}>{children}</TabActivity> : null}
      </div>
    </section>
  );
}
