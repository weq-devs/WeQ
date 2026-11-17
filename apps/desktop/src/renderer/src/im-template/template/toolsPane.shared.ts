import { defaultToolRegistry, type ToolPaneItem, type ToolPaneGroup } from './toolRegistry';

export type ToolPaneEntry = {
  group: ToolPaneGroup;
  item: ToolPaneItem;
};

export function flattenToolRegistry(
  registry: ToolPaneGroup[] = defaultToolRegistry,
  query = '',
): ToolPaneEntry[] {
  const normalizedQuery = query.trim().toLowerCase();

  return registry.flatMap((group) =>
    group.items
      .filter((item) => {
        if (!normalizedQuery) {
          return true;
        }
        return [item.label, item.description]
          .filter(Boolean)
          .some((value) => value?.toLowerCase().includes(normalizedQuery));
      })
      .map((item) => ({ group, item })),
  );
}
