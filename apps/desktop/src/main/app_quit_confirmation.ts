export type QuitChoice = 'quit' | 'window' | 'cancel';

interface QuitEvent {
  readonly defaultPrevented?: boolean;
  preventDefault(): void;
}

let skipNext = false;

/** 用户已经确认的重启或退出后清除，不再被助手的普通退出提示打断。 */
export function skipNextQuitConfirmation(): void {
  skipNext = true;
}

/** 必须先于保存、释放服务与销毁托盘运行；取消退出不应改变运行状态。 */
export function registerAppQuitConfirmation(
  app: {
    prependListener(event: 'before-quit', listener: (event: QuitEvent) => void): unknown;
    quit(): void;
  },
  updater: { on(event: 'before-quit-for-update', listener: () => void): unknown },
  options: {
    needsConfirmation(): boolean;
    bypass(): boolean;
    showDialog(): Promise<QuitChoice>;
    hideWindow(): void;
    failed(error: unknown): void;
  },
): () => void {
  let approved = false;
  let pending = false;
  let generation = 0;
  updater.on('before-quit-for-update', () => {
    approved = true;
    generation += 1;
  });
  app.prependListener('before-quit', (event) => {
    if (event.defaultPrevented) return;
    const skipped = skipNext;
    skipNext = false;
    if (approved || skipped || options.bypass() || !options.needsConfirmation()) {
      approved = true;
      generation += 1;
      return;
    }
    event.preventDefault();
    if (pending) return;
    pending = true;
    const expected = generation;
    void (async () => {
      try {
        const choice = await options.showDialog();
        if (expected !== generation) return;
        if (choice === 'quit') {
          approved = true;
          app.quit();
        } else if (choice === 'window') {
          options.hideWindow();
        }
      } catch (error) {
        options.failed(error);
      } finally {
        pending = false;
      }
    })();
  });
  // beforeunload 被用户取消后，下一次退出不能沿用上一次的确认。
  return () => {
    approved = false;
    generation += 1;
  };
}
