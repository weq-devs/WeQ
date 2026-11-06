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

/** 已独占打开的归档文件按有界块写入；提交点显式 flush 后再 fsync。 */
export function bufferedFileWriter(
  file: { writeFile(data: string): Promise<void> },
  limit = 65536,
) {
  let chunks: string[] = [],
    bytes = 0;
  const flush = async (): Promise<void> => {
    if (!chunks.length) return;
    const text = chunks.join('');
    chunks = [];
    bytes = 0;
    await file.writeFile(text);
  };
  return {
    async write(text: string): Promise<void> {
      chunks.push(text);
      bytes += Buffer.byteLength(text);
      if (bytes >= limit) await flush();
    },
    flush,
  };
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
