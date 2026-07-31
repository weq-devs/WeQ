/**
 * Bridge between `node:http` and the Web `Request`/`Response` pair that the
 * protocol handlers speak.
 *
 * The desktop app serves media through Electron custom schemes, whose handlers
 * are `(Request) => Response`. Those handlers were made shell-agnostic in M2,
 * so the web app reuses them verbatim — this file only translates the envelope:
 *
 *   GET /_media/pic?t=1&name=x   →   weq-media://pic?t=1&name=x
 *
 * `Range` is forwarded both ways so `<video>`/`<audio>` seeking works.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

/** Build a Web `Request` addressed to `scheme://<first-segment>/...`. */
export function toProtocolRequest(
  req: IncomingMessage,
  scheme: string,
  mountPath: string,
): Request | null {
  const raw = req.url ?? '/';
  if (!raw.startsWith(mountPath)) return null;
  // `/_media/pic?x=1` → rest = `pic?x=1`
  const rest = raw.slice(mountPath.length).replace(/^\/+/, '');
  if (!rest) return null;

  const qMark = rest.indexOf('?');
  const pathPart = qMark === -1 ? rest : rest.slice(0, qMark);
  const query = qMark === -1 ? '' : rest.slice(qMark);
  // The custom schemes are "standard", so the first segment is the authority
  // (`weq-media://pic`) and the remainder is the path.
  const slash = pathPart.indexOf('/');
  const host = slash === -1 ? pathPart : pathPart.slice(0, slash);
  const path = slash === -1 ? '' : pathPart.slice(slash);

  const headers = new Headers();
  const range = req.headers.range;
  if (typeof range === 'string') headers.set('range', range);

  return new Request(`${scheme}://${host}${path}${query}`, { method: 'GET', headers });
}

/** Write a Web `Response` out to a `node:http` response, streaming the body. */
export async function writeResponse(res: ServerResponse, out: Response): Promise<void> {
  const headers: Record<string, string> = {};
  out.headers.forEach((value, key) => {
    headers[key] = value;
  });
  res.writeHead(out.status, headers);

  if (!out.body) {
    res.end();
    return;
  }
  const nodeStream = Readable.fromWeb(out.body as Parameters<typeof Readable.fromWeb>[0]);
  nodeStream.pipe(res);
  await new Promise<void>((resolve) => {
    nodeStream.on('end', resolve);
    nodeStream.on('error', () => {
      res.destroy();
      resolve();
    });
    res.on('close', resolve);
  });
}
