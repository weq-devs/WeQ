import { getHost } from './host';

export const DEVELOPMENT_DRESS_FLAG = '--enable-dress-tools';

export function resolveDevelopmentDressTools(input: {
  packaged: boolean;
  nodeEnv: string | undefined;
  args: readonly string[];
}): boolean {
  return (
    !input.packaged &&
    input.nodeEnv === 'development' &&
    input.args.includes(DEVELOPMENT_DRESS_FLAG)
  );
}

/** 仅针对装扮实验工具；未安装宿主时默认不开启。 */
export function developmentDressToolsEnabled(): boolean {
  try {
    return resolveDevelopmentDressTools({
      packaged: getHost().isPackaged(),
      nodeEnv: process.env.NODE_ENV,
      args: process.argv,
    });
  } catch {
    return false;
  }
}

export function requireDevelopmentDressTools(): void {
  if (!developmentDressToolsEnabled()) throw new Error('当前运行环境未启用装扮开发工具');
}
