import { Fragment, useContext, useState } from 'react';
import { LayoutList, UserRound } from 'lucide-react';
import {
  CONTACT_CARD_FIELDS,
  CONTACT_GROUP_FIELDS,
  moveContactCardField,
  normalizeContactCard,
  type ContactCardContent,
  type ContactCardField,
  type ContactGroupField,
  type ContactCardSettings as Preferences,
} from '@weq/service/contact-card';
import { useContactCardSettings } from '../../hooks/useContactCard';
import {
  CONTACT_CARD_SECTIONS,
  contactCardFieldGroup,
  moveContactCardSectionField,
} from '../../lib/contactCardSections';
import { trpc } from '../../trpc/client';
import { AutoSave } from './AutoSave';
import { Card, Row, SectionHeader, Toggle } from './controls';
import { SettingsResetCardContext, SettingsResetContext } from './resetContext';
import { ContactFieldSort } from './contactCard/ContactFieldSort';
import '../../styles/contact-card.css';

const cardLabels = new Map<string, string>(CONTACT_CARD_FIELDS.map(([key, label]) => [key, label]));
const groupLabels = new Map<string, string>(
  CONTACT_GROUP_FIELDS.map(([key, label]) => [key, label]),
);

/**
 * 设置 → 基础功能 → 联系人名片。
 *
 * 字段按实际名片分区显示；正文在分区内排序，身份区只切换显示。
 */
export function ContactCardSettings() {
  const source = useContactCardSettings();
  const saved = normalizeContactCard(source);
  const reset = useContext(SettingsResetContext);
  const [optimistic, setOptimistic] = useState<Preferences | null>(null);
  const utils = trpc.useUtils();
  const mutation = trpc.bootstrap.setContactCard.useMutation();
  const value = optimistic ?? saved;
  const disabled = !source.ready || mutation.isLoading;
  const allFields = [...value.order, ...value.groupOrder];
  const visibleCount = allFields.filter((key) => value.visible[key]).length;
  function save(next: Preferences) {
    setOptimistic(next);
  }
  async function persist(next: Preferences) {
    await mutation.mutateAsync(next);
    await utils.bootstrap.getSettings.invalidate();
    setOptimistic((current) => (JSON.stringify(current) === JSON.stringify(next) ? null : current));
  }
  function setVisible(key: ContactCardContent, next: boolean) {
    void save({ ...value, visible: { ...value.visible, [key]: next } });
  }
  return (
    <SettingsResetCardContext.Provider value={reset?.saves('contact-card') ?? null}>
      <div className="weq-set weq-contact-card-settings" data-setting-id="contact-card">
        <SectionHeader
          title="联系人名片"
          icon={<UserRound size={16} strokeWidth={1.8} />}
          desc="可点击顶部头像预览效果"
        />
        <Card
          title="名片资料"
          icon={<LayoutList size={15} strokeWidth={1.8} />}
          settingId="contact-card-fields"
        >
          <Row
            settingId="contact-card-all"
            label="全部字段"
            desc={`共 ${allFields.length} 个字段，已显示 ${visibleCount} 个。`}
            control={
              <span className="weq-contact-toggle-all">
                <button
                  type="button"
                  className="weq-set-btn weq-set-btn-soft"
                  disabled={disabled || visibleCount === allFields.length}
                  onClick={() =>
                    void save({
                      ...value,
                      visible: Object.fromEntries(
                        Object.keys(value.visible).map((key) => [key, true]),
                      ) as Preferences['visible'],
                    })
                  }
                >
                  全部显示
                </button>
                <button
                  type="button"
                  className="weq-set-btn weq-set-btn-soft"
                  disabled={disabled || visibleCount === 0}
                  onClick={() =>
                    void save({
                      ...value,
                      visible: Object.fromEntries(
                        Object.keys(value.visible).map((key) => [key, false]),
                      ) as Preferences['visible'],
                    })
                  }
                >
                  全部隐藏
                </button>
              </span>
            }
          />
          {CONTACT_CARD_SECTIONS.map((section) => (
            <Fragment key={section.key}>
              <section
                className="weq-contact-settings-section"
                aria-labelledby={`contact-card-${section.key}-title`}
              >
                <h4 id={`contact-card-${section.key}-title`}>{section.title}</h4>
                <ContactFieldSort
                  id={`contact-card-${section.key}-sort`}
                  title={section.title}
                  keys={value.order.filter((key) => contactCardFieldGroup(key) === section.key)}
                  labels={(key: ContactCardField) => cardLabels.get(key) ?? key}
                  disabled={disabled}
                  sortable={section.key !== 'identity'}
                  control={(key) => (
                    <Toggle
                      checked={Boolean(value.visible[key])}
                      disabled={disabled}
                      label={cardLabels.get(key) ?? key}
                      onChange={(next) => setVisible(key, next)}
                    />
                  )}
                  onMove={(key: ContactCardField, offset: number) =>
                    void save({
                      ...value,
                      order: moveContactCardSectionField(value.order, key, offset),
                    })
                  }
                />
              </section>
              {section.key === 'identity' ? (
                <section
                  className="weq-contact-settings-section"
                  data-setting-id="contact-card-group-fields"
                  aria-labelledby="contact-card-group-title"
                >
                  <h4 id="contact-card-group-title">群内资料</h4>
                  <ContactFieldSort
                    id="contact-card-group-sort"
                    title="群内资料"
                    keys={value.groupOrder}
                    labels={(key: ContactGroupField) => groupLabels.get(key) ?? key}
                    disabled={disabled}
                    control={(key) => (
                      <Toggle
                        checked={Boolean(value.visible[key])}
                        disabled={disabled}
                        label={groupLabels.get(key) ?? key}
                        onChange={(next) => setVisible(key, next)}
                      />
                    )}
                    onMove={(key: ContactGroupField, offset: number) =>
                      void save({
                        ...value,
                        groupOrder: moveContactCardField(value.groupOrder, key, offset),
                      })
                    }
                  />
                </section>
              ) : null}
            </Fragment>
          ))}
        </Card>
        <AutoSave
          value={value}
          saved={saved}
          ready={source.ready}
          save={persist}
          reset={() => setOptimistic(null)}
          resetKeys={['contactCard']}
        />
      </div>
    </SettingsResetCardContext.Provider>
  );
}
