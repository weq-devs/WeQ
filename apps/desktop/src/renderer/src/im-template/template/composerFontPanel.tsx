import { Check, Plus, Trash2, Type } from 'lucide-react';
import { useEffect, useId, useState, type RefObject } from 'react';
import { EmptyState } from '../../components/EmptyState';
import { EditorDialog } from '../../components/EditorDialog';
import { ConversationActionsMenu } from '../../components/ConversationActionsMenu';
import { DressSearchForm } from '../../components/DressSearchForm';
import { ShimmerImage } from '../../components/ShimmerImage';
import { observeCompactToolbar } from '../../components/CompactToolbar.shared';
import { Toggle } from '../../components/settings/controls';
import { ActionIcon } from '../../components/qq-actions/shared';
import { useDevelopmentDressTools } from '../../hooks/useDevelopmentDressTools';
import { fontFaces } from '../../lib/fontFaces';
import { messageFontFamily } from '../../lib/msgDecorationStyle';
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
    select: (data) => ({
      preferences: data.composerFont,
      showMessageFont: data.showMessageFont,
    }),
  });
  const preferences = settings.data?.preferences;
  const warmSendFont = preferences?.send && settings.data?.showMessageFont !== false;
  const dress = trpc.account.dressup.getState.useQuery(undefined, {
    enabled: available && (open || !!preferences?.preview || !!warmSendFont),
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
  const fontId = available && (preferences?.preview || warmSendFont) ? currentId : 0;
  const installed = fontId ? manifest?.fonts.find((font) => font.itemId === fontId) : undefined;
  const resolved = trpc.account.dressup.resolveMsgDecoration.useQuery(
    { fontId, bubbleId: 0, widgetId: 0 },
    { enabled: !!fontId && !installed, staleTime: Infinity, retry: false },
  );
  const derived = resolved.data?.font ?? installed;
  const family = useFontFamily(derived ? fontId : 0, derived?.deriveVersion);

  return {
    development,
    state,
    preferences,
    selected,
    family: preferences?.preview ? family : '',
  };
}

function useFontFamily(itemId: number, version = 0): string {
  const family = itemId ? messageFontFamily(itemId, version) : '';
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
  const [menu, setMenu] = useState<{ x: number; y: number; itemId: number } | null>(null);
  const utils = trpc.useUtils();
  const save = trpc.bootstrap.setComposerFont.useMutation({
    onSuccess: (composerFont) => {
      utils.bootstrap.getSettings.setData(undefined, (data) =>
        data ? { ...data, composerFont } : data,
      );
    },
  });
  const remove = trpc.account.dressup.removeComposerFont.useMutation({
    onSuccess: async (composerFont) => {
      utils.bootstrap.getSettings.setData(undefined, (data) =>
        data ? { ...data, composerFont } : data,
      );
      await utils.account.dressup.getState.invalidate();
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
  const disabled = !preferences || save.isLoading || remove.isLoading;
  const usesPersonalFont = selected !== 'plain';
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
        {options.map((item) => {
          const itemId = typeof item.value === 'number' ? item.value : undefined;
          return (
            <label
              key={item.value}
              className="composer-font-option"
              data-unavailable={item.disabled}
              onContextMenu={
                itemId
                  ? (event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setMenu({ x: event.clientX, y: event.clientY, itemId });
                    }
                  : undefined
              }
              onKeyDown={
                itemId
                  ? (event) => {
                      if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10'))
                        return;
                      event.preventDefault();
                      const rect = event.currentTarget.getBoundingClientRect();
                      setMenu({ x: rect.left, y: rect.bottom, itemId });
                    }
                  : undefined
              }
            >
              <input
                type="radio"
                name={id}
                checked={item.value === selected}
                disabled={item.disabled || disabled}
                aria-haspopup={itemId ? 'menu' : undefined}
                onChange={() => save.mutate({ choice: item.value })}
              />
              <FontSample item={item} />
              <span className="composer-font-option-label">
                <strong>{item.name}</strong>
                {!item.disabled && item.description ? <small>{item.description}</small> : null}
              </span>
              <Check size={16} aria-hidden />
            </label>
          );
        })}
      </div>
      {menu ? (
        <ConversationActionsMenu
          x={menu.x}
          y={menu.y}
          label="个性字体操作"
          onClose={() => setMenu(null)}
          actions={[
            {
              label: '删除',
              icon: <Trash2 size={15} />,
              danger: 'outline',
              disabled,
              action: () => remove.mutate({ itemId: menu.itemId }),
            },
          ]}
        />
      ) : null}
      {remove.error || save.error ? (
        <div className="composer-font-error" role="alert">
          {(remove.error ?? save.error)?.message}
        </div>
      ) : null}
      <footer className="composer-font-controls">
        <div>
          <span>发送个性字体</span>
          <Toggle
            label="发送个性字体"
            checked={usesPersonalFont && (preferences?.send ?? true)}
            disabled={disabled || !usesPersonalFont}
            onChange={(enabled) => setToggle('send', enabled)}
          />
        </div>
        <div>
          <span>预览个性字体</span>
          <Toggle
            label="预览个性字体"
            checked={usesPersonalFont && (preferences?.preview ?? false)}
            disabled={disabled || !usesPersonalFont}
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
