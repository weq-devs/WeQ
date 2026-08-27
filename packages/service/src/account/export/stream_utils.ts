/**
 * Stream-to-disk with real error propagation.
 *
 * The naive `if (!stream.write(chunk)) await once(stream, 'drain')` pattern
 * hangs forever when the underlying file can't be opened (bad path, locked
 * file, full disk): the stream emits `error` and `drain` never fires. Every
 * exporter used that pattern, so a bad output path silently froze the task.
 *
 * This wrapper attaches an `error` listener up front, records the first error,
 * and rejects every subsequent `write` / `end` ? so a failed export surfaces as
 * a task failure instead of a permanent hang.
 */
import { createWriteStream } from 'node:fs';
import { finished } from 'node:stream/promises';

export interface ExportWriter {
  write(chunk: string): Promise<void>;
  end(): Promise<void>;
}

export function createExportWriter(outputPath: string): ExportWriter {
  const stream = createWriteStream(outputPath, { encoding: 'utf-8' });
  let streamError: Error | null = null;

  // Consume the error event (avoids an unhandled-'error' crash) and remember it.
  stream.on('error', (e: Error) => {
    streamError = e;
  });

  const write = (chunk: string): Promise<void> => {
    if (streamError) return Promise.reject(streamError);
    if (stream.write(chunk)) return Promise.resolve();
    // Backpressure: wait for drain, but bail out on error instead of hanging.
    return new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        stream.off('drain', onDrain);
        stream.off('error', onError);
      };
      const onDrain = (): void => {
        cleanup();
        resolve();
      };
      const onError = (e: Error): void => {
        cleanup();
        reject(e);
      };
      stream.once('drain', onDrain);
      stream.once('error', onError);
    });
  };

  const end = async (): Promise<void> => {
    if (streamError) throw streamError;
    stream.end();
    await finished(stream);
  };

  return { write, end };
}
