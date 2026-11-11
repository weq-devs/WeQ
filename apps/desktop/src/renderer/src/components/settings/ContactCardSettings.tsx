import { useContext, useState } from 'react';
import { ArrowDown, ArrowUp, GripVertical, UserRound } from 'lucide-react';
import {
  CONTACT_CARD_FIELDS,
  CONTACT_GROUP_FIELDS,
  moveContactCardField,
  normalizeContactCard,
  type ContactCardSettings as Preferences,
  type ContactCardContent,
} from '@weq/service/contact-card';
import { useContactCardSettings } from '../../hooks/useContactCard';
import { trpc } from '../../trpc/client';
import { SettingsResetButton } from './SettingsReset';
import { AutoSave } from './AutoSave';
import { SettingsResetCardContext, SettingsResetContext } from './resetContext';
import { ContactCardPreview } from '../contactProfile/ContactCardPreview';
import '../../styles/contact-card.css';

export function ContactCardSettings() {
  const source = useContactCardSettings();
  const saved = normalizeContactCard(source);
  const reset = useContext(SettingsResetContext);
  const [optimistic, setOptimistic] = useState<Preferences | null>(null);
  const [dragged, setDragged] = useState<ContactCardContent | null>(null);
  const utils = trpc.useUtils();
  const mutation = trpc.bootstrap.setContactCard.useMutation();
  const value = optimistic ?? saved;
  function save(next: Preferences) {
    setOptimistic(next);
  }
  async function persist(next: Preferences) {
    await mutation.mutateAsync(next);
    await utils.bootstrap.getSettings.invalidate();
    setOptimistic((current) => (JSON.stringify(current) === JSON.stringify(next) ? null : current));
  }
  return (
    <SettingsResetCardContext.Provider value={reset?.saves('contact-card') ?? null}>
      <section className="weq-set" data-setting-id="contact-card">
        <header className="weq-contact-settings-head">
          <h2>
            <UserRound size={18} />
            联系人名片
          </h2>
          <SettingsResetButton card="contact-card" />
        </header>
        <AutoSave
          value={value}
          saved={saved}
          ready={source.ready}
          save={persist}
          reset={() => setOptimistic(null)}
          resetKeys={['contactCard']}
        />
        <div className="weq-contact-settings-grid">
          <div>
            {(['order', 'groupOrder'] as const).map((group) => {
              const catalog = group === 'order' ? CONTACT_CARD_FIELDS : CONTACT_GROUP_FIELDS;
              return (
                <section key={group} className="weq-contact-settings-section">
                  <h3>{group === 'order' ? '展示内容' : '群上下文'}</h3>
                  <ul>
                    {value[group].map((key, index) => (
                      <li
                        data-setting-id={`contact-card-${key}`}
                        key={key}
                        draggable={source.ready && !mutation.isLoading}
                        onDragStart={() => setDragged(key)}
                        onDragEnd={() => setDragged(null)}
                        onDragOver={(event) => event.preventDefault()}
                        onDrop={(event) => {
                          event.preventDefault();
                          const keys: ContactCardContent[] = value[group];
                          if (!dragged || !keys.includes(dragged)) return;
                          void save({
                            ...value,
                            [group]: moveContactCardField(
                              keys,
                              dragged,
                              index - keys.indexOf(dragged),
                            ),
                          });
                          setDragged(null);
                        }}
                      >
                        <GripVertical size={14} aria-hidden />
                        <label>
                          <input
                            type="checkbox"
                            checked={value.visible[key]}
                            disabled={!source.ready || mutation.isLoading}
                            onChange={(event) =>
                              void save({
                                ...value,
                                visible: { ...value.visible, [key]: event.target.checked },
                              })
                            }
                          />
                          {catalog.find(([id]) => id === key)?.[1]}
                        </label>
                        {([-1, 1] as const).map((offset) => (
                          <button
                            key={offset}
                            type="button"
                            className="weq-set-iconbtn"
                            title={offset < 0 ? '上移' : '下移'}
                            aria-label={`${offset < 0 ? '上移' : '下移'}${catalog.find(([id]) => id === key)?.[1]}`}
                            disabled={
                              !source.ready ||
                              mutation.isLoading ||
                              index + offset < 0 ||
                              index + offset >= value[group].length
                            }
                            onClick={() =>
                              void save({
                                ...value,
                                [group]: moveContactCardField<ContactCardContent>(
                                  value[group],
                                  key,
                                  offset,
                                ),
                              })
                            }
                          >
                            {offset < 0 ? <ArrowUp size={14} /> : <ArrowDown size={14} />}
                          </button>
                        ))}
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
          <aside className="weq-contact-settings-preview">
            <ContactCardPreview settings={value} />
          </aside>
        </div>
      </section>
    </SettingsResetCardContext.Provider>
  );
}
