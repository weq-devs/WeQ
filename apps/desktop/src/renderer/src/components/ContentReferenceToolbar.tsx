import { Download, ListChecks, ListX, X } from 'lucide-react';
import type { ReactNode } from 'react';
import '../styles/content-reference-selection.css';
import { useRequestContentExport, type useContentMultiSelect } from '../state/contentSelection';
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
  const all = loaded.length > 0 && loaded.every((id) => selection.selectedIds.has(id));
  const button = (label: string, icon: ReactNode, run: () => void, disabled = false) => (
    <button
      type="button"
      className="weq-set-iconbtn"
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
        <>
          <span role="status">已选 {selection.selectedIds.size} 项</span>
          {button(all ? '取消全选已加载项' : '全选已加载项', <ListChecks size={17} />, () =>
            selection.setSelectedIds((previous) => {
              const next = new Set(previous);
              for (const id of loaded) {
                if (all) next.delete(id);
                else next.add(id);
              }
              return next;
            }),
          )}
          {button('反选已加载项', <ListX size={17} />, () =>
            selection.setSelectedIds((previous) => {
              const next = new Set(previous);
              for (const id of loaded) {
                if (next.has(id)) next.delete(id);
                else next.add(id);
              }
              return next;
            }),
          )}
          {button(
            '导出所选内容',
            <Download size={17} />,
            () =>
              request?.({
                owner,
                scope: {
                  type: 'references',
                  items: selection.references.map((item) => ({ ...item })),
                },
              }),
            !selection.references.length || !request,
          )}
          {button('退出多选', <X size={17} />, () => selection.setSelectionMode(false))}
        </>
      )}
    </div>
  );
}
