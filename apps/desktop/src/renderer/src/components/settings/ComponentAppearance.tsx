import type { KeyboardEvent } from 'react';
import { Check, Search } from 'lucide-react';
import { componentStyles, useThemeStore, type ThemeComponentStyle } from '../../state/theme';

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

export function ComponentStylePreview({ style }: { style: ThemeComponentStyle }) {
  return (
    <span className="weq-style-preview" data-component-preview={style} aria-hidden="true">
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
        <span className="weq-style-preview-item">
          <span className="weq-style-preview-avatar" />
          <span className="weq-style-preview-lines">
            <i />
            <i />
          </span>
        </span>
        <span className="weq-style-preview-item is-selected">
          <span className="weq-style-preview-avatar" />
          <span className="weq-style-preview-lines">
            <i />
            <i />
          </span>
          <Check size={11} />
        </span>
      </span>
      <span className="weq-style-preview-footer">
        <span className="weq-style-preview-button" />
        <span className="weq-style-preview-button is-primary">
          <Check size={10} />
        </span>
      </span>
    </span>
  );
}

export function ComponentAppearance() {
  const style = useThemeStore((state) => state.componentStyle);
  const density = useThemeStore((state) => state.density);
  const setStyle = useThemeStore((state) => state.setComponentStyle);
  const setDensity = useThemeStore((state) => state.setDensity);
  return (
    <>
      <div
        className="weq-settings-appearance-card weq-component-appearance"
        data-setting-id="component-style"
      >
        <div className="weq-settings-appearance-head">
          <strong>组件风格</strong>
        </div>
        <div
          className="weq-style-options"
          role="radiogroup"
          aria-label="组件风格"
          onKeyDown={navigateOptions}
        >
          {componentStyles.map((option) => (
            <button
              type="button"
              className="weq-style-option"
              key={option.value}
              role="radio"
              aria-label={option.label}
              aria-checked={style === option.value}
              tabIndex={style === option.value ? 0 : -1}
              onClick={() => setStyle(option.value)}
            >
              <ComponentStylePreview style={option.value} />
              <span className="weq-style-option-label">
                {option.label}
                {style === option.value && <Check size={14} aria-hidden="true" />}
              </span>
            </button>
          ))}
        </div>
      </div>
      <div
        className="weq-settings-appearance-card weq-component-appearance"
        data-setting-id="interface-density"
      >
        <div className="weq-settings-appearance-head">
          <strong>界面密度</strong>
        </div>
        <div
          className="weq-density-options"
          role="radiogroup"
          aria-label="界面密度"
          onKeyDown={navigateOptions}
        >
          {(
            [
              { value: 'comfortable', label: '舒适' },
              { value: 'compact', label: '紧凑' },
            ] as const
          ).map((option) => (
            <button
              type="button"
              key={option.value}
              role="radio"
              aria-checked={density === option.value}
              tabIndex={density === option.value ? 0 : -1}
              onClick={() => setDensity(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
