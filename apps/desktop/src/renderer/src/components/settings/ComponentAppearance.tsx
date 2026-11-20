import type { KeyboardEvent, ReactNode } from 'react';
import { Check, LayoutGrid, Palette, Search, Type, X } from 'lucide-react';
import {
  componentStyles,
  useThemeStore,
  type ThemeComponentStyle,
  type ThemeDensity,
} from '../../state/theme';
import { Card } from './controls';

const densityOptions = [
  { value: 'comfortable', label: '舒适' },
  { value: 'compact', label: '紧凑' },
] as const;

function navigateOptions(event: KeyboardEvent<HTMLDivElement>) {
  const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
  if (!keys.includes(event.key)) return;
  const buttons = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]'),
  );
  const current = buttons.indexOf(event.target as HTMLButtonElement);
  if (current < 0) return;
  event.preventDefault();
  const offset = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
  const index =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? buttons.length - 1
        : (current + offset + buttons.length) % buttons.length;
  buttons[index]?.focus();
  buttons[index]?.click();
}

function AppearanceOption({
  label,
  selected,
  onSelect,
  children,
}: {
  label: string;
  selected: boolean;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="weq-style-option"
      role="radio"
      aria-label={label}
      aria-checked={selected}
      tabIndex={selected ? 0 : -1}
      onClick={onSelect}
    >
      {children}
      <span className="weq-style-option-label">
        <span>{label}</span>
        {selected && <Check size={14} aria-hidden="true" />}
      </span>
    </button>
  );
}

function PreviewConversation({ selected = false }: { selected?: boolean }) {
  return (
    <span className={selected ? 'weq-style-preview-item is-selected' : 'weq-style-preview-item'}>
      <span className="weq-style-preview-avatar" />
      <span className="weq-style-preview-lines">
        <i />
        <i />
      </span>
    </span>
  );
}

function ComponentStylePreview({
  style,
  density,
}: {
  style: ThemeComponentStyle;
  density?: ThemeDensity;
}) {
  return (
    <span
      className="weq-style-preview"
      data-component-preview={style}
      data-density-preview={density}
      aria-hidden="true"
    >
      <span className="weq-style-preview-bar">
        <span className="weq-style-preview-input">
          <Search size={11} />
          <span />
        </span>
        <span className="weq-style-preview-toggle">
          <span />
        </span>
      </span>
      <span className="weq-style-preview-list">
        <PreviewConversation selected />
        <PreviewConversation />
        {density && <PreviewConversation />}
        {density === 'compact' && <PreviewConversation />}
      </span>
      {!density && (
        <>
          <span className="weq-style-preview-chat">
            <span className="weq-style-preview-bubble" />
            <span className="weq-style-preview-bubble is-mine" />
          </span>
          <span className="weq-style-preview-footer">
            <span className="weq-style-preview-button">
              <X size={10} />
            </span>
            <span className="weq-style-preview-button is-primary">
              <Check size={10} />
            </span>
          </span>
        </>
      )}
    </span>
  );
}

export function ComponentAppearance() {
  const style = useThemeStore((state) => state.componentStyle);
  const density = useThemeStore((state) => state.density);
  const specialNumberFont = useThemeStore((state) => state.specialNumberFont);
  const setStyle = useThemeStore((state) => state.setComponentStyle);
  const setDensity = useThemeStore((state) => state.setDensity);
  const setSpecialNumberFont = useThemeStore((state) => state.setSpecialNumberFont);
  return (
    <>
      <Card
        title="组件风格"
        desc="会话列表、气泡与按钮的整体造型"
        icon={<Palette size={15} strokeWidth={1.8} />}
        resetId="theme-components"
        settingId="component-style"
      >
        <div
          className="weq-style-options"
          role="radiogroup"
          aria-label="组件风格"
          onKeyDown={navigateOptions}
        >
          {componentStyles.map((option) => (
            <AppearanceOption
              key={option.value}
              label={option.label}
              selected={style === option.value}
              onSelect={() => setStyle(option.value)}
            >
              <ComponentStylePreview style={option.value} />
            </AppearanceOption>
          ))}
        </div>
      </Card>
      <Card
        title="界面密度"
        desc="调整设置、列表与工具栏的行高与留白"
        icon={<LayoutGrid size={15} strokeWidth={1.8} />}
        settingId="interface-density"
      >
        <div
          className="weq-style-options weq-style-options-pair"
          role="radiogroup"
          aria-label="界面密度"
          onKeyDown={navigateOptions}
        >
          {densityOptions.map((option) => (
            <AppearanceOption
              key={option.value}
              label={option.label}
              selected={density === option.value}
              onSelect={() => setDensity(option.value)}
            >
              <ComponentStylePreview style={style} density={option.value} />
            </AppearanceOption>
          ))}
        </div>
      </Card>
      <Card
        title="字体"
        desc="选择时间、编号与统计读数的数字字体"
        icon={<Type size={15} strokeWidth={1.8} />}
        resetId="theme-font"
        settingId="special-number-font"
      >
        <div
          className="weq-style-options weq-number-font-options"
          role="radiogroup"
          aria-label="数字字体"
          onKeyDown={navigateOptions}
        >
          {[
            { enabled: true, label: '特殊数字字体' },
            { enabled: false, label: '跟随界面字体' },
          ].map(({ enabled, label }) => (
            <button
              type="button"
              className="weq-style-option"
              key={label}
              role="radio"
              aria-label={label}
              aria-checked={specialNumberFont === enabled}
              tabIndex={specialNumberFont === enabled ? 0 : -1}
              onClick={() => setSpecialNumberFont(enabled)}
            >
              <span
                className="weq-number-font-preview"
                data-number-font-preview={enabled ? 'special' : 'interface'}
                aria-hidden="true"
              >
                <strong>11/21</strong>
                <strong>09:41</strong>
                <strong>1,024</strong>
                <strong>78%</strong>
              </span>
              <span className="weq-style-option-label">
                <span>{label}</span>
                {specialNumberFont === enabled && <Check size={14} aria-hidden="true" />}
              </span>
            </button>
          ))}
        </div>
      </Card>
    </>
  );
}
