import type { Plugin, Rolldown } from 'vite';

/** 只合并工作区本来就会加载的静态依赖，不跨越 import() 边界。 */
export function remoteStartupChunks() {
  const required = new Set<string>();
  const group: Rolldown.CodeSplittingGroup = {
    name: 'workspace',
    test: (id) => required.has(id),
    includeDependenciesRecursively: false,
    maxSize: 350_000,
    priority: -10,
  };
  const plugin: Plugin = {
    name: 'weq-remote-startup-chunks',
    apply: 'build',
    buildStart() {
      required.clear();
    },
    buildEnd(error) {
      if (error) return;
      const collect = (id: string, target: Set<string>) => {
        if (target.has(id)) return;
        target.add(id);
        for (const dependency of this.getModuleInfo(id)?.importedIds ?? [])
          collect(dependency, target);
      };
      const initial = new Set<string>();
      for (const id of this.getModuleIds()) {
        if (this.getModuleInfo(id)?.isEntry) collect(id, initial);
        if (/\/views\/(MainView|ChatHome)\.tsx$/.test(id.replaceAll('\\', '/')))
          collect(id, required);
      }
      // 共享入口依赖必须留在入口组，否则静态引用可能反向拉入整个工作区。
      for (const id of initial) required.delete(id);
    },
  };
  const groups: Rolldown.CodeSplittingGroup[] = [
    {
      name: 'startup',
      tags: ['$initial'],
      includeDependenciesRecursively: false,
      maxSize: 350_000,
      priority: 0,
    },
    group,
  ];
  return { plugin, groups };
}
