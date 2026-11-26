import { Search, X } from 'lucide-react';

export function DressSearchForm({
  label,
  placeholder,
  value,
  onChange,
  onSearch,
  disabled = false,
  maxLength,
}: {
  label: string;
  placeholder?: string;
  value: string;
  onChange: (value: string) => void;
  onSearch: (keyword: string) => void;
  disabled?: boolean;
  maxLength?: number;
}) {
  return (
    <form
      className="weq-dress-search"
      role="search"
      aria-label={label}
      onSubmit={(event) => {
        event.preventDefault();
        if (!disabled) onSearch(value.trim());
      }}
    >
      <Search size={15} aria-hidden />
      <input
        aria-label={label}
        placeholder={disabled ? '搜索需要登录 QQ' : (placeholder ?? `${label}，回车确认`)}
        enterKeyHint="search"
        value={value}
        maxLength={maxLength}
        disabled={disabled}
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
      />
      {value ? (
        <button
          type="button"
          className="weq-dress-search-clear"
          aria-label="清空搜索"
          title="清空搜索"
          onClick={() => {
            onChange('');
            onSearch('');
          }}
        >
          <X size={13} aria-hidden />
        </button>
      ) : null}
    </form>
  );
}
