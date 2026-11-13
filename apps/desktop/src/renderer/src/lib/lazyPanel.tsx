import { lazy, Suspense, type ComponentType } from 'react';
import { PanelLoading } from '../components/LoadingIndicator';

/** 导航意图与真正打开复用同一次模块请求；预热只加载代码，不发业务查询。 */
export function lazyPanel<Props extends object>(
  load: () => Promise<{ default: ComponentType<Props> }>,
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
        <Suspense fallback={<PanelLoading />}>
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
