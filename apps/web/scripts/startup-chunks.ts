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
      const beforeWorkspace = new Set<string>();
      for (const id of this.getModuleIds()) {
        const path = id.replaceAll('\\', '/');
        if (this.getModuleInfo(id)?.isEntry || path.endsWith('/views/bootstrap/SelectScreen.tsx'))
          collect(id, beforeWorkspace);
        if (/\/views\/(MainView|ChatHome)\.tsx$/.test(path)) collect(id, required);
      }
      // 入口及账号选择器的共享依赖不能反向拉入工作区专用分包。
      for (const id of beforeWorkspace) required.delete(id);
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
