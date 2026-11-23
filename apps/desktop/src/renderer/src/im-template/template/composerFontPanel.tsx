import { Check, Plus, Type } from 'lucide-react';
import { useEffect, useId, useState, type RefObject } from 'react';
import { EmptyState } from '../../components/EmptyState';
import { EditorDialog } from '../../components/EditorDialog';
import { DressSearchForm } from '../../components/DressSearchForm';
import { ShimmerImage } from '../../components/ShimmerImage';
import { observeCompactToolbar } from '../../components/CompactToolbar.shared';
import { Toggle } from '../../components/settings/controls';
import { ActionIcon } from '../../components/qq-actions/shared';
import { useDevelopmentDressTools } from '../../hooks/useDevelopmentDressTools';
import { fontFaces } from '../../lib/fontFaces';
import { dressFontUrl, dressUrl } from '../../lib/resourceUrl';
import { trpc } from '../../trpc/client';
import type { ComposerFontSettings } from '@weq/service';
import '../../styles/dressup.css';
import '../../styles/composer-font.css';

const FONT_EXAMPLE = '字体预览 Aa';

type FontOption = {
  value: 'plain' | 'qq' | number;
  name: string;
  preview?: string;
  description?: string;
  localFont?: { itemId: number; deriveVersion?: number };
  disabled?: boolean;
};

export function useComposerFont(available: boolean, open: boolean) {
  const development = useDevelopmentDressTools();
  const settings = trpc.bootstrap.getSettings.useQuery(undefined, {
    enabled: available,
    refetchOnWindowFocus: false,
    staleTime: 60_000,
    select: (data) => data.composerFont,
  });
  const preferences = settings.data;
  const dress = trpc.account.dressup.getState.useQuery(undefined, {
    enabled: available && (open || preferences?.preview === true),
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  });
  const state = dress.data;
  const manifest = state?.manifest;
  const qqFont = state?.own.fontId ?? 0;
  const choice = preferences?.choice;
  const customId = development && typeof choice === 'number' ? choice : 0;
  const legacyId = development && choice === 'legacy-dress' ? (manifest?.activeFont ?? 0) : 0;
  const selected: FontOption['value'] =
    customId || legacyId || (choice === 'qq' && qqFont ? 'qq' : 'plain');
  const currentId = selected === 'qq' ? qqFont : typeof selected === 'number' ? selected : 0;
  const previewId = available && preferences?.preview ? currentId : 0;
  const installed = previewId
    ? manifest?.fonts.find((font) => font.itemId === previewId)
    : undefined;
  const resolved = trpc.account.dressup.resolveMsgDecoration.useQuery(
    { fontId: previewId, bubbleId: 0, widgetId: 0 },
    { enabled: !!previewId && !installed, staleTime: 60_000, retry: false },
  );
  const derived = installed ?? resolved.data?.font;
  const family = useFontFamily(derived ? previewId : 0, derived?.deriveVersion);

  return {
    development,
    state,
    preferences,
    selected,
    family,
  };
}

function useFontFamily(itemId: number, version = 0): string {
  const family = itemId ? `weq-composer-${itemId}-${version}` : '';
  const [loaded, setLoaded] = useState('');
  useEffect(() => {
    if (!family) return;
    let active = true;
    const lease = fontFaces.acquire(family, dressFontUrl(itemId, version));
    void lease.ready.then((ready) => {
      if (active) setLoaded(ready ? family : '');
    });
    return () => {
      active = false;
      lease.release();
    };
  }, [family, itemId, version]);
  return family && family === loaded ? family : '';
}

function FontSample({ item }: { item: FontOption }) {
  const family = useFontFamily(
    item.preview ? 0 : (item.localFont?.itemId ?? 0),
    item.localFont?.deriveVersion,
  );
  return (
    <span className="composer-font-sample">
      {item.preview ? (
        <ShimmerImage src={dressUrl(item.preview)} alt="" loading="lazy" />
      ) : (
        <span aria-hidden style={family ? { fontFamily: family } : undefined}>
          {item.disabled ? '未设置' : FONT_EXAMPLE}
        </span>
      )}
    </span>
  );
}

export function ComposerFontPanel({
  panelRef,
  font,
}: {
  panelRef: RefObject<HTMLDivElement | null>;
  font: ReturnType<typeof useComposerFont>;
}) {
  const { development, preferences, selected, state } = font;
  const id = useId();
  const [adding, setAdding] = useState(false);
  const utils = trpc.useUtils();
  const save = trpc.bootstrap.setComposerFont.useMutation({
    onSuccess: (composerFont) => {
      utils.bootstrap.getSettings.setData(undefined, (data) =>
        data ? { ...data, composerFont } : data,
      );
    },
  });
  const own = state?.own;
  const fonts = state?.manifest.fonts ?? [];
  const ownInstalled = own?.fontId ? fonts.find((item) => item.itemId === own.fontId) : undefined;
  const options: FontOption[] = [
    { value: 'plain', name: '普通字体' },
    {
      value: 'qq',
      name: 'QQ 同款',
      preview: own?.fontPreviewUrl || ownInstalled?.previewUrl,
      localFont: ownInstalled,
      description: own?.fontId ? own.fontName : state ? '未设置' : '正在读取',
      disabled: !own?.fontId,
    },
  ];
  if (development) {
    for (const item of fonts) {
      if (item.itemId > 0xffff || (item.itemId === own?.fontId && item.itemId !== selected))
        continue;
      options.push({
        value: item.itemId,
        name: item.name || `字体 ${item.itemId}`,
        preview: item.previewUrl,
        localFont: item,
      });
    }
  }
  const disabled = !preferences || save.isLoading;
  function setToggle(key: 'send' | 'preview', enabled: boolean) {
    save.mutate({ [key]: enabled } satisfies Partial<ComposerFontSettings>);
  }

  return (
    <div
      ref={panelRef}
      className="emoji-panel composer-font-panel"
      role="group"
      aria-label="个性字体"
    >
      <header ref={observeCompactToolbar} className="emoji-panel-header">
        <h3>个性字体</h3>
        {development ? (
          <div className="emoji-header-actions">
            <ActionIcon label="添加个性字体" text="添加" onClick={() => setAdding(true)}>
              <Plus size={16} />
            </ActionIcon>
          </div>
        ) : null}
      </header>
      <div
        className="emoji-panel-body composer-font-list"
        data-expanded={development}
        role="radiogroup"
        aria-label="选择字体"
      >
        {options.map((item) => (
          <label key={item.value} className="composer-font-option" data-unavailable={item.disabled}>
            <input
              type="radio"
              name={id}
              checked={item.value === selected}
              disabled={item.disabled || disabled}
              onChange={() => save.mutate({ choice: item.value })}
            />
            <FontSample item={item} />
            <span className="composer-font-option-label">
              <strong>{item.name}</strong>
              {!item.disabled && item.description ? <small>{item.description}</small> : null}
            </span>
            <Check size={16} aria-hidden />
          </label>
        ))}
      </div>
      {save.error ? (
        <div className="composer-font-error" role="alert">
          {save.error.message}
        </div>
      ) : null}
      <footer className="composer-font-controls">
        <div>
          <span>发送个性字体</span>
          <Toggle
            label="发送个性字体"
            checked={preferences?.send ?? true}
            disabled={disabled}
            onChange={(enabled) => setToggle('send', enabled)}
          />
        </div>
        <div>
          <span>预览个性字体</span>
          <Toggle
            label="预览个性字体"
            checked={preferences?.preview ?? false}
            disabled={disabled}
            onChange={(enabled) => setToggle('preview', enabled)}
          />
        </div>
      </footer>
      {adding ? (
        <ComposerFontCatalog
          installedIds={new Set(fonts.map(({ itemId }) => itemId))}
          onClose={() => setAdding(false)}
        />
      ) : null}
    </div>
  );
}

function ComposerFontCatalog({
  installedIds,
  onClose,
}: {
  installedIds: ReadonlySet<number>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState('');
  const [keyword, setKeyword] = useState('');
  const utils = trpc.useUtils();
  const rank = trpc.account.dressup.rank.useQuery({ kind: 'font' }, { enabled: !keyword });
  const search = trpc.account.dressup.search.useQuery(
    { kind: 'font', keyword },
    { enabled: !!keyword, retry: false },
  );
  const install = trpc.account.dressup.installFont.useMutation({
    onSuccess: async () => {
      await utils.account.dressup.getState.invalidate();
    },
  });
  const catalog = keyword ? search : rank;
  const items = (catalog.data?.items ?? []).filter(({ itemId }) => itemId > 0 && itemId <= 0xffff);
  return (
    <EditorDialog title="添加个性字体" width={720} onClose={onClose}>
      <DressSearchForm
        label="搜索聊天字体"
        maxLength={50}
        value={draft}
        onChange={setDraft}
        onSearch={setKeyword}
      />
      {install.error ? <div role="alert">{install.error.message}</div> : null}
      {catalog.isFetching && !items.length ? (
        <div className="emoji-state" role="status">
          加载中…
        </div>
      ) : !items.length ? (
        <EmptyState compact icon={<Type />} title={catalog.error?.message ?? '没有找到聊天字体'} />
      ) : (
        <div className="weq-dress-grid composer-font-catalog">
          {items.map((item) => {
            const added = installedIds.has(item.itemId);
            const preview = item.previewLargeUrl || item.previewUrl;
            return (
              <div key={item.itemId} className="weq-dress-card">
                <div className="weq-dress-card-preview">
                  {preview ? (
                    <ShimmerImage src={dressUrl(preview)} alt="" loading="lazy" />
                  ) : (
                    <span aria-hidden>{FONT_EXAMPLE}</span>
                  )}
                </div>
                <div className="weq-dress-card-body">
                  <strong title={item.name}>{item.name}</strong>
                </div>
                <div className="weq-dress-card-actions">
                  <button
                    type="button"
                    className="weq-set-btn"
                    disabled={added || install.isLoading}
                    onClick={() =>
                      install.mutate({
                        itemId: item.itemId,
                        name: item.name,
                        previewUrl: preview || undefined,
                      })
                    }
                  >
                    {added
                      ? '已添加'
                      : install.isLoading && install.variables?.itemId === item.itemId
                        ? '添加中…'
                        : '添加'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </EditorDialog>
  );
}
