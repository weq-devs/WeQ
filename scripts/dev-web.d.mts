interface WebAssetsOptions {
  env?: NodeJS.ProcessEnv;
  cache?: boolean;
  build?: (root: string, env: NodeJS.ProcessEnv) => void | Promise<void>;
  log?: (message: string, level?: string, scope?: string) => void;
  marker?: string;
}

export function prepareWebAssets(
  root: string,
  options?: WebAssetsOptions,
): Promise<{ cached: boolean; durationMs?: number }>;
