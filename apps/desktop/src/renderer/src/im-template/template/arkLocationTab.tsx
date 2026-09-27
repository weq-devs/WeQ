// @ts-nocheck
/**
 * Ark 面板的「位置卡片」tab。
 *
 * 三件事：**搜**（腾讯位置服务输入提示）→ **选**（地图点一下）→ **填**（逆地址
 * 解析给出的省市区 / 地址），三个结果都落到可编辑的输入框里 —— 用户想改成什么
 * 就是什么，面板不写死任何地名。
 *
 * 一个刻意的规则：自动填**不覆盖用户手打的字**。每次自动写入都记下自己写了什么
 * （`autoRef`），下一轮只有「还是我上次写的那句」或「字段是空的」才继续覆盖；
 * 用户一改，这个字段就归用户了。想强制刷新就按「解析地址」。
 *
 * 搜索与逆地址解析都由应用层注入（`ArkLocationProvider`），面板自己不碰网络：
 * 渲染层 CSP 是 `connect-src 'self'`，而且 key 不该落进前端。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Locate, MapPin, Search, X } from 'lucide-react';
import { cn } from './classNames';
import { composeLocationAddress, type ArkLocationProvider } from './arkCards';
import { DEFAULT_CENTER, LocationPicker } from './locationPicker';

/** 位置卡片的四个可编辑字段。 */
export type ArkLocationDraft = {
  /** 详细地址（卡片上那行小字）。 */
  address: string;
  /** 省市区。 */
  region: string;
  latitude: string;
  longitude: string;
};

export function emptyLocationDraft(): ArkLocationDraft {
  return { address: '', region: '', latitude: '', longitude: '' };
}

/** 搜索去抖：输入停下来 300ms 才发请求，别一个字一个请求。 */
const SEARCH_DEBOUNCE_MS = 300;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ArkLocationTab({
  value,
  onChange,
  provider,
  disabled,
}: {
  value: ArkLocationDraft;
  onChange: (patch: Partial<ArkLocationDraft>) => void;
  /** 搜索 / 逆地址解析能力；应用层没接上时整块搜索栏不渲染（手填仍然可用）。 */
  provider?: ArkLocationProvider;
  disabled?: boolean;
}) {
  const [keyword, setKeyword] = useState('');
  const [suggestions, setSuggestions] = useState<
    Awaited<ReturnType<ArkLocationProvider['suggest']>>
  >([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState<string | null>(null);

  const valueRef = useRef(value);
  valueRef.current = value;
  /** 上一次**自动**写入的值：用户没改过才允许再覆盖（见文件头）。 */
  const autoRef = useRef<{ address: string | null; region: string | null }>({
    address: null,
    region: null,
  });
  /** 请求序号：慢的那次回来时丢掉，别覆盖新的结果。 */
  const searchSeq = useRef(0);

  const center = useMemo(() => {
    const lat = Number(value.latitude);
    const lng = Number(value.longitude);
    return Number.isFinite(lat) &&
      Number.isFinite(lng) &&
      value.latitude !== '' &&
      value.longitude !== ''
      ? { latitude: lat, longitude: lng }
      : { latitude: DEFAULT_CENTER.lat, longitude: DEFAULT_CENTER.lng };
  }, [value.latitude, value.longitude]);
  const centerRef = useRef(center);
  centerRef.current = center;

  // 关键词变化 → 去抖搜索。
  useEffect(() => {
    if (!provider) return;
    const text = keyword.trim();
    if (!text) {
      setSuggestions([]);
      setSearchError(null);
      setActiveIndex(-1);
      return;
    }
    const seq = ++searchSeq.current;
    const timer = setTimeout(() => {
      setSearching(true);
      setSearchError(null);
      provider
        .suggest(text, centerRef.current)
        .then((rows) => {
          if (seq !== searchSeq.current) return;
          setSuggestions(rows);
          setActiveIndex(rows.length > 0 ? 0 : -1);
        })
        .catch((error) => {
          if (seq !== searchSeq.current) return;
          setSuggestions([]);
          setSearchError(messageOf(error));
        })
        .finally(() => {
          if (seq === searchSeq.current) setSearching(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [keyword, provider]);

  /**
   * 把解析结果写进字段。`force` = 用户主动按「解析地址」，覆盖一切；否则只覆盖
   * 「空的」或「上一次也是自动写的」字段。
   */
  const applyResolved = useCallback(
    (resolved: { title: string; address: string; region: string }, force: boolean) => {
      const current = valueRef.current;
      const patch: Partial<ArkLocationDraft> = {};
      const address = composeLocationAddress(resolved.title, resolved.address);

      const writable = (field: 'address' | 'region', next: string): boolean => {
        if (!next) return false;
        if (force) return true;
        const now = current[field].trim();
        return now === '' || now === autoRef.current[field]?.trim();
      };

      if (writable('address', address)) {
        patch.address = address;
        autoRef.current.address = address;
      }
      if (writable('region', resolved.region)) {
        patch.region = resolved.region;
        autoRef.current.region = resolved.region;
      }
      if (Object.keys(patch).length > 0) onChange(patch);
    },
    [onChange],
  );

  /** 逆地址解析一个坐标（点选 / 主动按钮共用）。 */
  const resolve = useCallback(
    async (latitude: string, longitude: string, force: boolean): Promise<void> => {
      if (!provider) return;
      setResolving(true);
      setResolveError(null);
      try {
        const resolved = await provider.reverse(Number(latitude), Number(longitude));
        applyResolved(resolved, force);
      } catch (error) {
        setResolveError(messageOf(error));
      } finally {
        setResolving(false);
      }
    },
    [provider, applyResolved],
  );

  function pickSuggestion(suggestion: {
    title: string;
    address: string;
    region: string;
    latitude: number;
    longitude: number;
  }): void {
    const latitude = suggestion.latitude.toFixed(6);
    const longitude = suggestion.longitude.toFixed(6);
    // 搜索结果是用户主动挑的：地址直接写进去，不走「不覆盖手打」那套。
    onChange({
      latitude,
      longitude,
      region: suggestion.region,
      address: composeLocationAddress(suggestion.title, suggestion.address),
    });
    autoRef.current.address = composeLocationAddress(suggestion.title, suggestion.address);
    autoRef.current.region = suggestion.region;
    setKeyword('');
    setSuggestions([]);
    setActiveIndex(-1);
  }

  function handleMapPick(latitude: string, longitude: string): void {
    onChange({ latitude, longitude });
    // 点完顺手把地址补上；已经有用户手打的字就不会被覆盖。
    void resolve(latitude, longitude, false);
  }

  const canResolve = value.latitude.trim() !== '' && value.longitude.trim() !== '';

  return (
    <>
      {provider ? (
        <div className={cn('ark-locate')}>
          <div className={cn('ark-search')}>
            <Search size={14} strokeWidth={2} />
            <input
              type="text"
              value={keyword}
              placeholder="搜索地点"
              spellCheck={false}
              disabled={disabled}
              onChange={(event) => setKeyword(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  if (suggestions.length === 0) return;
                  event.preventDefault();
                  const step = event.key === 'ArrowDown' ? 1 : -1;
                  setActiveIndex(
                    (current) => (current + step + suggestions.length) % suggestions.length,
                  );
                  return;
                }
                if (event.key === 'Enter') {
                  // 压住回车：默认行为会把表单提上去，变成「在搜索框里敲回车
                  // 就把卡片发出去了」。选不中建议时就只是不做事。
                  event.preventDefault();
                  const hit = suggestions[activeIndex];
                  if (hit) pickSuggestion(hit);
                  return;
                }
                if (event.key === 'Escape') {
                  // 先收搜索：还有词 / 建议时停在这一层，空了才让 Esc 冒到面板去关闭。
                  if (keyword || suggestions.length > 0) {
                    event.stopPropagation();
                    setKeyword('');
                    setSuggestions([]);
                    setActiveIndex(-1);
                  }
                }
              }}
            />
            {searching ? <Loader2 size={13} strokeWidth={2.4} className={cn('ark-spin')} /> : null}
            {keyword ? (
              <button
                type="button"
                className={cn('ark-search-clear')}
                title="清空"
                onClick={() => {
                  setKeyword('');
                  setSuggestions([]);
                }}
              >
                <X size={13} strokeWidth={2.4} />
              </button>
            ) : null}
          </div>

          {suggestions.length > 0 ? (
            <ul className={cn('ark-suggest')}>
              {suggestions.map((suggestion, index) => (
                <li key={suggestion.id || `${suggestion.title}-${index}`}>
                  <button
                    type="button"
                    className={cn('ark-suggest-item', index === activeIndex && 'active')}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => pickSuggestion(suggestion)}
                  >
                    <span className={cn('ark-suggest-title')}>
                      <MapPin size={12} strokeWidth={2.1} />
                      {suggestion.title || suggestion.address}
                    </span>
                    <span className={cn('ark-suggest-addr')}>
                      {suggestion.region}
                      {suggestion.address}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}

          {searchError ? <p className={cn('ark-locate-error')}>{searchError}</p> : null}
        </div>
      ) : null}

      <LocationPicker
        latitude={value.latitude}
        longitude={value.longitude}
        onPick={handleMapPick}
        disabled={disabled}
      />

      {resolveError ? <p className={cn('ark-locate-error')}>{resolveError}</p> : null}

      <div className={cn('ark-grid-2')}>
        <label className={cn('link-card-field')}>
          <span className={cn('link-card-label')}>
            地址
            <em className={cn('ark-req')} title="必填">
              *
            </em>
          </span>
          <span className={cn('link-card-input')}>
            <MapPin size={14} strokeWidth={1.9} />
            <input
              type="text"
              value={value.address}
              placeholder="地点名称 / 详细地址"
              onChange={(event) => onChange({ address: event.target.value })}
            />
          </span>
        </label>
        <label className={cn('link-card-field')}>
          <span className={cn('link-card-label')}>
            地区
            <em className={cn('ark-req')} title="必填">
              *
            </em>
          </span>
          <span className={cn('link-card-input')}>
            <input
              type="text"
              value={value.region}
              placeholder="省市区"
              onChange={(event) => onChange({ region: event.target.value })}
            />
          </span>
        </label>
      </div>

      <div className={cn('ark-grid-2')}>
        <label className={cn('link-card-field')}>
          <span className={cn('link-card-label')}>纬度</span>
          <span className={cn('link-card-input')}>
            <input
              type="text"
              inputMode="decimal"
              value={value.latitude}
              onChange={(event) => onChange({ latitude: event.target.value })}
            />
          </span>
        </label>
        <label className={cn('link-card-field')}>
          <span className={cn('link-card-label')}>经度</span>
          <span className={cn('link-card-input')}>
            <input
              type="text"
              inputMode="decimal"
              value={value.longitude}
              onChange={(event) => onChange({ longitude: event.target.value })}
            />
          </span>
        </label>
      </div>

      <div className={cn('ark-locate-tools')}>
        <button
          type="button"
          className={cn('link-card-btn', 'ghost')}
          disabled={!provider || !canResolve || resolving || disabled}
          title={canResolve ? '按坐标重新解析地址（会覆盖当前地址）' : '先在地图上点一下'}
          onClick={() => void resolve(value.latitude, value.longitude, true)}
        >
          {resolving ? (
            <Loader2 size={13} strokeWidth={2.4} className={cn('ark-spin')} />
          ) : (
            <Locate size={13} strokeWidth={2.2} />
          )}
        </button>
      </div>
    </>
  );
}
