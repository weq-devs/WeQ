import { lazy, Suspense, type ComponentType, type ReactNode } from 'react';
import { PanelLoading } from '../components/LoadingIndicator';

/** 导航意图与真正打开复用同一次模块请求；预热只加载代码，不发业务查询。 */
export function lazyPanel<Props extends object>(
  load: () => Promise<{ default: ComponentType<Props> }>,
  fallback: (props: Props) => ReactNode = () => <PanelLoading />,
) {
  let pending: ReturnType<typeof load> | undefined;
  const module = () => {
    pending ??= load().catch((error: unknown) => {
      pending = undefined;
      throw error;
    });
    return pending;
  };
  const Component = lazy(module);
  return Object.assign(
    function DeferredPanel(props: Props) {
      return (
        <Suspense fallback={fallback(props)}>
          <Component {...props} />
        </Suspense>
      );
    },
    {
      preload: async () => {
        await module();
      },
    },
  );
}

/** 已加载的页面保留现场；离开仍在加载的页面时，不再让它的等待或失败影响当前页。 */
export function lazyRetainedPanel<Props extends { active?: boolean }>(
  load: () => Promise<{ default: ComponentType<Props> }>,
) {
  let loaded = false;
  const Panel = lazyPanel<Props>(
    async () => {
      const result = await load();
      loaded = true;
      return result;
    },
    ({ active }) => (active !== false ? <PanelLoading startup={false} /> : null),
  );
  return Object.assign(
    function RetainedPanel(props: Props) {
      return loaded || props.active !== false ? <Panel {...props} /> : null;
    },
    { preload: Panel.preload },
  );
}
