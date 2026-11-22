/** 返回最后一个完整 UTF-8 字符之后的字节位置。 */
function utf8Boundary(chunk: Uint8Array): number {
  const size = chunk.length;
  if (!size) return 0;
  let start = size - 1;
  while (start > size - 4 && start > 0 && (chunk[start]! & 0xc0) === 0x80) start--;
  const lead = chunk[start]!;
  const width = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return size - start < width ? start : size;
}

function utf8Chunks() {
  let tail: Uint8Array | undefined;
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(incoming, stream) {
      let chunk = incoming;
      if (tail) {
        chunk = new Uint8Array(tail.length + incoming.length);
        chunk.set(tail);
        chunk.set(incoming, tail.length);
      }
      const end = utf8Boundary(chunk);
      tail = end < chunk.length ? chunk.slice(end) : undefined;
      if (end) stream.enqueue(tail ? chunk.subarray(0, end) : chunk);
    },
    flush(stream) {
      if (tail) stream.enqueue(tail);
    },
  });
}

/** tRPC v10 逐块解码。对齐字符边界，旧宿主的 JSON 批次也走同一套结果交付。 */
export async function prepareRpcBatchResponse(
  response: Response,
  input: RequestInfo | URL,
): Promise<Response> {
  if (!response.body) return response;
  const streaming = response.headers
    .get('vary')
    ?.split(',')
    .some((value) => value.trim().toLowerCase() === 'trpc-batch-mode');
  if (streaming) return new Response(response.body.pipeThrough(utf8Chunks()), response);

  const result: unknown = await response.json();
  const url = new URL(input instanceof Request ? input.url : input, location.href);
  const count = url.pathname.split(',').length;
  // 普通 tRPC 批次的通用错误对所有操作生效，沿用同一结果及索引。
  const rows = Array.isArray(result) ? result : Array.from({ length: count }, () => result);
  const framed = rows
    .map((row, index) => `${index === 0 ? '{' : ','}"${index}":${JSON.stringify(row)}\n`)
    .join('');
  return new Response(`${framed}}`, response);
}
