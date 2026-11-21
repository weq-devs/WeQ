import { Download, ListChecks, CheckCheck, FlipHorizontal2, X } from 'lucide-react';
import { MessageSelectionBar } from './MessageSelectionBar';
import type { ReactNode } from 'react';
import '../styles/content-reference-selection.css';
import { useRequestContentExport } from '../state/contentSelection.shared';
import type { useContentMultiSelect } from '../state/contentSelection.shared';
import type { ContentOwner } from '../../../shared/content_selection';

export function ContentReferenceToolbar({
  owner,
  selection,
  loaded,
}: {
  owner: ContentOwner;
  selection: ReturnType<typeof useContentMultiSelect>;
  loaded: string[];
}) {
  const request = useRequestContentExport();
  return (
    <ContentSelectionToolbar
      selection={selection}
      loaded={loaded}
      exportDisabled={!selection.references.length || !request}
      onExport={() =>
        request?.({
          owner,
          scope: {
            type: 'references',
            items: selection.references.map((item) => ({ ...item })),
          },
        })
      }
    />
  );
}

export function ContentSelectionToolbar({
  selection,
  loaded,
  subject = '内容',
  unit = '项',
  exportDisabled,
  onExport,
}: {
  selection: Pick<
    ReturnType<typeof useContentMultiSelect>,
    'selectedIds' | 'setSelectedIds' | 'selectionMode' | 'setSelectionMode'
  >;
  loaded: string[];
  subject?: string;
  unit?: string;
  exportDisabled: boolean;
  onExport: () => void;
}) {
  const all = loaded.length > 0 && loaded.every((id) => selection.selectedIds.has(id));
  const button = (label: string, icon: ReactNode, run: () => void, disabled = false) => (
    <button
      type="button"
      className="selection-action"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={run}
    >
      {icon}
    </button>
  );
  return (
    <div className="weq-reference-toolbar">
      {!selection.selectionMode ? (
        button('多选', <ListChecks size={17} />, () => selection.setSelectionMode(true))
      ) : (
        <MessageSelectionBar count={selection.selectedIds.size} unit={unit} subject={subject}>
          {button(all ? '取消全选已加载项' : '全选已加载项', <CheckCheck size={17} />, () =>
            selection.setSelectedIds((previous) => {
              const next = new Set(previous);
              for (const id of loaded) {
                if (all) next.delete(id);
                else next.add(id);
              }
              return next;
            }),
          )}
          {button('反选已加载项', <FlipHorizontal2 size={17} />, () =>
            selection.setSelectedIds((previous) => {
              const next = new Set(previous);
              for (const id of loaded) {
                if (next.has(id)) next.delete(id);
                else next.add(id);
              }
              return next;
            }),
          )}
          {button(`导出所选${subject}`, <Download size={17} />, onExport, exportDisabled)}
          {button('退出多选', <X size={17} />, () => selection.setSelectionMode(false))}
        </MessageSelectionBar>
      )}
    </div>
  );
}
