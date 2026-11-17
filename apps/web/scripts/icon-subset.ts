import { dirname, resolve } from 'node:path';
import { build } from 'esbuild';
import { normalizePath, type Plugin } from 'vite';

/** 仅定向预构建选用图标，React 继续复用网页现有实例；正式构建沿用原有裁剪。 */
export function developmentIconSubset(entry: string): Plugin {
  const source = normalizePath(resolve(entry));
  return {
    name: 'weq-development-icon-subset',
    apply: 'serve',
    config: () => ({ optimizeDeps: { exclude: ['react-icons/si', 'react-icons/ai'] } }),
    async load(id) {
      if (id !== source) return;
      const directory = dirname(source);
      const output = await build({
        absWorkingDir: directory,
        entryPoints: [source],
        bundle: true,
        format: 'esm',
        platform: 'browser',
        external: ['react'],
        treeShaking: true,
        minify: true,
        metafile: true,
        write: false,
      });
      for (const name of Object.keys(output.metafile.inputs))
        this.addWatchFile(resolve(directory, name));
      return output.outputFiles[0]!.text;
    },
  };
}
