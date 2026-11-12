import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Plus, RefreshCw, Save, Trash2 } from 'lucide-react';
import type { FriendNotes } from '@weq/protocol';
import { trpc } from '../trpc/client';
import type { useQQWriteSession } from '../hooks/useQQWriteSession';
import { useDialog } from './Dialog';

type Session = ReturnType<typeof useQQWriteSession>;
type NotesState = FriendNotes & { revision: string };

export function FriendNotesForm({
  initial,
  disabled,
  onDirtyChange,
  onSave,
}: {
  initial: NotesState;
  disabled: boolean;
  onDirtyChange: (dirty: boolean) => void;
  onSave: (notes: FriendNotes) => Promise<boolean>;
}) {
  const id = useId();
  const nextRow = useRef(0);
  const noteRow = (value: string) => ({ id: `${id}-${nextRow.current++}`, value });
  const [company, setCompany] = useState(initial.company);
  const [phones, setPhones] = useState(() => initial.phones.map(noteRow));
  const [descriptions, setDescriptions] = useState(() => initial.descriptions.map(noteRow));
  const dirty =
    company !== initial.company ||
    JSON.stringify(phones.map((row) => row.value)) !== JSON.stringify(initial.phones) ||
    JSON.stringify(descriptions.map((row) => row.value)) !== JSON.stringify(initial.descriptions);
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  return (
    <form
      className="weq-friend-notes-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!disabled && dirty)
          void onSave({
            company,
            phones: phones.map((row) => row.value).filter(Boolean),
            descriptions: descriptions.map((row) => row.value).filter(Boolean),
          });
      }}
    >
      <label htmlFor={`${id}-company`}>我备注的公司</label>
      <input
        id={`${id}-company`}
        className="weq-qq-write-input"
        value={company}
        maxLength={1024}
        disabled={disabled}
        onChange={(event) => setCompany(event.target.value)}
      />
      {(
        [
          { label: '我备注的电话', values: phones, set: setPhones, multiline: false },
          { label: '我备注的描述', values: descriptions, set: setDescriptions, multiline: true },
        ] as const
      ).map(({ label, values, set, multiline }) => (
        <fieldset key={label} disabled={disabled}>
          <legend>{label}</legend>
          {values.map((row, index) => {
            const props = {
              'aria-label': `${label} ${index + 1}`,
              className: 'weq-qq-write-input',
              value: row.value,
              maxLength: 4096,
              onChange: (event: { target: { value: string } }) =>
                set(
                  values.map((item) =>
                    item.id === row.id ? { ...item, value: event.target.value } : item,
                  ),
                ),
            };
            return (
              <div className="weq-friend-notes-item" key={row.id}>
                {multiline ? <textarea {...props} rows={2} /> : <input {...props} type="tel" />}
                <button
                  className="weq-set-iconbtn"
                  type="button"
                  title={`删除${label} ${index + 1}`}
                  aria-label={`删除${label} ${index + 1}`}
                  onClick={() => set(values.filter((item) => item.id !== row.id))}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            );
          })}
          <button
            className="weq-set-iconbtn"
            type="button"
            title={`添加${label}`}
            aria-label={`添加${label}`}
            disabled={values.length >= 100}
            onClick={() => set([...values, noteRow('')])}
          >
            <Plus size={16} />
          </button>
        </fieldset>
      ))}
      <div className="weq-friend-notes-actions">
        <button
          className="weq-set-iconbtn"
          type="submit"
          title="保存我的备注资料"
          aria-label="保存我的备注资料"
          disabled={disabled || !dirty}
        >
          <Save size={17} />
        </button>
      </div>
    </form>
  );
}

export function FriendNotesEditor({
  uid,
  session,
  onDirtyChange,
  initialExpanded = false,
}: {
  uid: string;
  session: Session;
  onDirtyChange: (dirty: boolean) => void;
  initialExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(initialExpanded);
  const [dirty, setDirty] = useState(false);
  const [reload, setReload] = useState(0);
  const confirm = useDialog((state) => state.confirm);
  const panelId = useId();
  const state = trpc.account.qqWrite.friendNotesState.useQuery(
    { ...session.binding!, uid },
    {
      enabled: expanded && session.available,
      staleTime: 0,
      retry: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    },
  );
  const mutation = trpc.account.qqWrite.friendNotes.useMutation();
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  return (
    <section className="weq-friend-notes">
      <div className="weq-friend-notes-heading">
        <button
          type="button"
          className="weq-friend-notes-disclosure"
          aria-expanded={expanded}
          aria-controls={panelId}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}我的备注资料
        </button>
        {expanded && (
          <button
            className="weq-set-iconbtn"
            type="button"
            aria-label="刷新我的备注资料"
            title="刷新我的备注资料"
            disabled={!session.available || session.busy || state.isFetching}
            onClick={async () => {
              if (
                dirty &&
                !(await confirm('放弃备注资料修改？', '刷新将重新读取我为好友添加的备注资料。'))
              )
                return;
              const updated = await state.refetch();
              if (!updated.error) {
                setReload((value) => value + 1);
                setDirty(false);
              }
            }}
          >
            <RefreshCw size={15} />
          </button>
        )}
      </div>
      <div id={panelId} hidden={!expanded}>
        {state.isLoading && session.available && <p role="status">正在读取我的备注资料…</p>}
        {state.error && <p role="alert">{state.error.message}</p>}
        {state.data && (
          <FriendNotesForm
            key={`${state.data.revision}:${reload}`}
            initial={state.data}
            disabled={
              !session.available || session.busy || state.isFetching || Boolean(state.error)
            }
            onDirtyChange={setDirty}
            onSave={(notes) =>
              session.run(
                (binding) =>
                  mutation.mutateAsync({ ...binding, uid, revision: state.data.revision, notes }),
                undefined,
                {
                  requireReadback: true,
                  readbackSuccessText: '我的备注资料已保存',
                  readback: async () => {
                    const updated = await state.refetch();
                    if (updated.error) throw updated.error;
                    return Boolean(
                      updated.data &&
                        updated.data.company === notes.company &&
                        JSON.stringify(updated.data.phones) === JSON.stringify(notes.phones) &&
                        JSON.stringify(updated.data.descriptions) ===
                          JSON.stringify(notes.descriptions),
                    );
                  },
                },
              )
            }
          />
        )}
      </div>
    </section>
  );
}
