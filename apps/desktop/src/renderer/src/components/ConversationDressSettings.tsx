import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { DressConversationEntry, DressConversationSlot, DressMallItem } from '@weq/service';
import { type client, trpc } from '../trpc/client';
import { accountBinding } from '../lib/clientPreferences';
import { useAppDialog } from '../lib/dialogUtils';
import { pickAccountFile } from '../lib/accountFilePicker';
import { IS_WEB } from '../lib/target.shared';
import { dressUrl } from '../lib/resourceUrl';
import { conversationDressLabel } from '../lib/conversationDress';
import { useDevelopmentDressTools } from '../hooks/useDevelopmentDressTools';
import { resolveChatBackdrop } from '../hooks/useDressSkin';
import { ChatBackdrop, ScreenWidget } from './ChatBackdrop';
import { DressOpacityControl } from './DressOpacityControl';
import { DressSearchForm } from './DressSearchForm';
import { FormSelect } from './FormSelect';
import { ShimmerImage } from './ShimmerImage';
import '../styles/dressup.css';

const LABELS = {
  callbg: '通话背景',
  background: '聊天背景',
  screen: '浮屏挂件',
} satisfies Record<DressConversationSlot, string>;

type OverrideInput = Parameters<typeof client.account.dressup.setConversationOverride.mutate>[0];
type OverrideChange = {
  [K in DressConversationSlot]: Pick<Extract<OverrideInput, { slot: K }>, 'slot' | 'value'>;
}[DressConversationSlot];

function CallBackgroundPicker({
  online,
  busy,
  onChoose,
}: {
  online: boolean;
  busy: boolean;
  onChoose: (item: DressMallItem) => void;
}) {
  const [draft, setDraft] = useState('');
  const [keyword, setKeyword] = useState('');
  const rank = trpc.account.dressup.rank.useQuery({ kind: 'callbg' }, { enabled: !keyword });
  const search = trpc.account.dressup.search.useQuery(
    { kind: 'callbg', keyword },
    { enabled: Boolean(keyword) && online, retry: false },
  );
  const query = keyword ? search : rank;
  const items = (query.data?.items ?? []).filter(
    (item) => item.previewLargeUrl || item.previewUrl || item.videoUrl,
  );

  return (
    <>
      {online || keyword ? (
        <DressSearchForm
          label="搜索通话背景"
          value={draft}
          onChange={setDraft}
          onSearch={setKeyword}
          disabled={!online}
          maxLength={50}
        />
      ) : null}
      {query.isInitialLoading ? <p role="status">正在加载通话背景</p> : null}
      {query.error ? (
        <button type="button" className="weq-set-btn" onClick={() => void query.refetch()}>
          加载通话背景失败，重试
        </button>
      ) : null}
      {keyword && !online ? (
        <button
          type="button"
          className="weq-set-btn"
          onClick={() => {
            setDraft('');
            setKeyword('');
          }}
        >
          返回热门通话背景
        </button>
      ) : null}
      {query.isSuccess && items.length === 0 ? <p>没有可用的通话背景</p> : null}
      <div className="weq-cvs-dress-options">
        {items.map((item) => {
          const image = dressUrl(item.previewLargeUrl || item.previewUrl);
          return (
            <button type="button" key={item.itemId} disabled={busy} onClick={() => onChoose(item)}>
              {image ? <ShimmerImage src={image} alt="" loading="lazy" /> : null}
              <span>{item.name || `通话背景 ${item.itemId}`}</span>
            </button>
          );
        })}
      </div>
    </>
  );
}

function ScreenWidgetPicker({
  busy,
  onChoose,
}: {
  busy: boolean;
  onChoose: (widgetId: string) => void;
}) {
  const widgets = trpc.account.dressup.widgets.useQuery(undefined, { staleTime: Infinity });
  return (
    <>
      {widgets.isInitialLoading ? <p role="status">正在加载浮屏挂件</p> : null}
      {widgets.error ? (
        <button type="button" className="weq-set-btn" onClick={() => void widgets.refetch()}>
          加载浮屏挂件失败，重试
        </button>
      ) : null}
      <div className="weq-cvs-dress-options">
        {(widgets.data ?? []).map(({ id }) => (
          <button type="button" key={id} disabled={busy} onClick={() => onChoose(id)}>
            <ScreenWidget widgetId={id} className="weq-cvs-dress-widget" />
            <span>挂件 {id}</span>
          </button>
        ))}
      </div>
    </>
  );
}

function ConversationDressRow({
  slot,
  entry,
  qqBackground,
  online,
  busy,
  onSave,
  onOpacity,
  onPick,
}: {
  slot: DressConversationSlot;
  entry: DressConversationEntry;
  qqBackground: string;
  online: boolean;
  busy: boolean;
  onSave: (change: OverrideChange) => Promise<boolean>;
  onOpacity: (slot: 'background' | 'screen', opacity: number) => Promise<boolean>;
  onPick: () => Promise<boolean>;
}) {
  const id = useId();
  const previewRef = useRef<HTMLDivElement>(null);
  const [choosing, setChoosing] = useState(false);
  const value = entry[slot];
  const selection = value && value !== 'off' ? value : undefined;
  const mode = choosing || selection ? 'custom' : value === 'off' ? 'off' : 'global';
  const label = LABELS[slot];
  const call = slot === 'callbg' ? entry.callbg : undefined;
  const background = slot === 'background' ? entry.background : undefined;
  const screen = slot === 'screen' ? entry.screen : undefined;
  const backdrop = resolveChatBackdrop(undefined, qqBackground, entry);
  const opacity =
    background && background !== 'off'
      ? background.opacity
      : screen && screen !== 'off'
        ? screen.opacity
        : 1;

  async function save(change: OverrideChange) {
    if (await onSave(change)) setChoosing(false);
  }

  return (
    <section className="weq-cvs-dress-row" aria-labelledby={id}>
      <div className="weq-cvs-dress-head">
        <div>
          <h3 id={id}>{label}</h3>
          {selection ? <small>{conversationDressLabel(entry, slot)}</small> : null}
        </div>
        <FormSelect
          aria-label={`本会话${label}`}
          value={mode}
          disabled={busy}
          onChange={(event) => {
            const next = event.target.value;
            if (next === 'custom') setChoosing(true);
            else void save({ slot, value: next === 'off' ? 'off' : null });
          }}
        >
          <option value="global">跟随全局</option>
          <option value="custom">单独选择</option>
          <option value="off">不使用</option>
        </FormSelect>
      </div>
      {selection && !choosing ? (
        <>
          <div className="weq-cvs-dress-preview" ref={previewRef}>
            {call && call !== 'off' ? (
              call.videoUrl ? (
                <video
                  src={dressUrl(call.videoUrl)}
                  poster={dressUrl(call.imageUrl) || undefined}
                  autoPlay
                  muted
                  loop
                  playsInline
                />
              ) : (
                <ShimmerImage src={dressUrl(call.imageUrl)} alt="" />
              )
            ) : (
              <ChatBackdrop
                {...backdrop}
                imageUrl={slot === 'background' ? backdrop.imageUrl : ''}
                videoUrl={slot === 'background' ? backdrop.videoUrl : ''}
                widgetId={slot === 'screen' ? backdrop.widgetId : ''}
                backgroundFollowsGlobal
                widgetFollowsGlobal
              />
            )}
          </div>
          {slot !== 'callbg' ? (
            <DressOpacityControl
              kind={slot === 'background' ? 'background' : 'widget'}
              value={opacity}
              previewRef={previewRef}
              disabled={busy}
              onCommit={async (next) => {
                await onOpacity(slot, next);
              }}
            />
          ) : null}
          <button
            type="button"
            className="weq-set-btn weq-set-btn-sm"
            disabled={busy}
            onClick={() => setChoosing(true)}
          >
            更换{label}
          </button>
        </>
      ) : null}
      {choosing ? (
        <>
          <div className="weq-cvs-dress-pick-actions">
            {slot === 'background' ? (
              <>
                <button
                  type="button"
                  className="weq-set-btn"
                  disabled={busy || !qqBackground}
                  title={qqBackground ? undefined : '该账号尚未设置 QQ 聊天背景'}
                  onClick={() =>
                    void save({ slot: 'background', value: { source: 'qq', opacity } })
                  }
                >
                  选择 QQ 同款
                </button>
                <button
                  type="button"
                  className="weq-set-btn"
                  disabled={busy}
                  onClick={async () => {
                    if (await onPick()) setChoosing(false);
                  }}
                >
                  选择图片或视频
                </button>
              </>
            ) : null}
            <button
              type="button"
              className="weq-set-btn"
              disabled={busy}
              onClick={() => setChoosing(false)}
            >
              取消选择
            </button>
          </div>
          {slot === 'callbg' ? (
            <CallBackgroundPicker
              online={online}
              busy={busy}
              onChoose={(item) =>
                void save({
                  slot: 'callbg',
                  value: {
                    itemId: item.itemId,
                    name: item.name,
                    imageUrl: item.previewLargeUrl || item.previewUrl,
                    videoUrl: item.videoUrl ?? '',
                  },
                })
              }
            />
          ) : null}
          {slot === 'screen' ? (
            <ScreenWidgetPicker
              busy={busy}
              onChoose={(widgetId) =>
                void save({
                  slot: 'screen',
                  value: { widgetId, opacity },
                })
              }
            />
          ) : null}
        </>
      ) : null}
    </section>
  );
}

export function ConversationDressSettings({
  kind,
  conv,
  title,
  initialSlot,
}: Pick<DressConversationEntry, 'kind' | 'conv' | 'title'> & {
  initialSlot?: DressConversationSlot;
}) {
  const binding = useRef(accountBinding());
  const dialog = useAppDialog();
  const utils = trpc.useUtils();
  const tools = useDevelopmentDressTools();
  const state = trpc.account.dressup.getState.useQuery(undefined, { staleTime: 60_000 });
  const setOverride = trpc.account.dressup.setConversationOverride.useMutation();
  const setOpacity = trpc.account.dressup.setConversationOpacity.useMutation();
  const pickBackground = trpc.account.dressup.pickConversationBackground.useMutation();
  const saving = useRef(false);
  const [busy, setBusy] = useState(false);
  const initialRow = useRef<HTMLDivElement>(null);
  const loaded = Boolean(state.data);
  const showCallBackground = tools && kind === 'c2c';
  useLayoutEffect(() => {
    if (loaded) initialRow.current?.scrollIntoView?.({ block: 'nearest' });
  }, [loaded, initialSlot, showCallBackground]);
  const target = { ...binding.current, kind, conv, title: title.trim().slice(0, 256) || conv };
  const entry = state.data?.conversationOverrides?.[`${kind}:${conv}`] ?? target;
  const slots: DressConversationSlot[] = showCallBackground
    ? ['callbg', 'background', 'screen']
    : ['background', 'screen'];

  async function commit(
    run: () => Promise<Record<string, DressConversationEntry> | null>,
  ): Promise<boolean> {
    if (saving.current) return false;
    saving.current = true;
    setBusy(true);
    try {
      const result = await run();
      if (!result) return false;
      if (accountBinding() === binding.current)
        utils.account.dressup.getState.setData(undefined, (current) =>
          current ? { ...current, conversationOverrides: result } : current,
        );
      return true;
    } catch (error) {
      dialog.error('保存会话装扮失败', error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }

  if (!state.data) {
    return state.error ? (
      <button type="button" className="weq-set-btn" onClick={() => void state.refetch()}>
        读取装扮失败，重试
      </button>
    ) : (
      <p role="status">正在读取装扮</p>
    );
  }

  return (
    <div className="weq-cvs-dress">
      {slots.map((slot) => (
        <div key={slot} ref={slot === initialSlot ? initialRow : undefined}>
          <ConversationDressRow
            slot={slot}
            entry={entry}
            qqBackground={state.data.own.chatBgUrl}
            online={state.data.qqOnline}
            busy={busy}
            onSave={(change) => commit(() => setOverride.mutateAsync({ ...target, ...change }))}
            onOpacity={(slot, opacity) =>
              commit(() => setOpacity.mutateAsync({ ...target, slot, opacity }))
            }
            onPick={() =>
              commit(async () => {
                const file = IS_WEB ? await pickAccountFile('file') : undefined;
                if (IS_WEB && !file) return null;
                return pickBackground.mutateAsync({ ...target, path: file?.path });
              })
            }
          />
        </div>
      ))}
    </div>
  );
}
