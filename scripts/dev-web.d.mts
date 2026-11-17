interface WebAssetsOptions {
  env?: NodeJS.ProcessEnv;
  cache?: boolean;
  build?: (root: string, env: NodeJS.ProcessEnv) => void | Promise<void>;
  log?: (message: string, level?: string, scope?: string) => void;
  marker?: string;
}

export function developmentWeb(root: string): {
  name: string;
  apply: 'serve';
  configureServer(server: {
    httpServer: { once(event: 'close', listener: () => void): unknown } | null;
  }): Promise<void>;
};

export function prepareWebAssets(
  root: string,
  options?: WebAssetsOptions,
): Promise<{ cached: boolean; durationMs?: number }>;
