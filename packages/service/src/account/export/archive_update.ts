import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { lstat, open, rename, statfs, unlink } from 'node:fs/promises';
import { canonical, checkArchiveShape, type JsonObject } from './archive';
import { type ArchiveEvent, scanArchiveFile, streamArchiveEvents } from './archive_stream';
import { archiveResource, fileDigest, syncArchiveDirectory } from './archive_resource';
import { bufferedFileWriter } from './stream_utils';
import { acquireArchiveLock } from './archive_lock';
import { compressArchiveBlock } from './archive_compression';

const recordKey = (value: JsonObject) => `${value.id}\0${value.revision}`;

/** 正式数据就是基线；索引丢失可流扫重建，既有未知字段不经展示模型重建。 */
export async function updateArchiveFile(
  target: string,
  incoming: string,
  format: 'json' | 'jsonl' | 'jsonl.gz',
  signal?: AbortSignal,
  resourceRoots?: { target: string; incoming: string },
): Promise<{ archiveId: string; entries: number; messageCount: number }> {
  assert(target !== incoming, '待合并文件不能覆盖正式归档');
  const lockPath = `${target}.weq-lock`;
  const lock = await acquireArchiveLock(lockPath);
  const temporary = `${target}.${randomUUID()}.tmp`;
  const observationPath = `${temporary}.observations`,
    resourcePath = `${temporary}.resources`;
  try {
    assert(
      (await lstat(target)).isFile() && !(await lstat(target)).isSymbolicLink(),
      '正式归档不是普通文件',
    );
    const fingerprint = await fileDigest(target);
    const old = await scanArchiveFile(target, format, signal),
      next = await scanArchiveFile(incoming, format, signal);
    assert(!next.state.uncommittedTail, '本轮待提交归档仍有未完成尾部');
    assert(
      canonical(old.header.scope.account) === canonical(next.header.scope.account),
      '归档账号不匹配',
    );
    assert(old.header.scope.partition === next.header.scope.partition, '归档账号分区不匹配');
    assert(
      old.header.version === next.header.version || old.header.version.startsWith('1.'),
      '不支持的归档版本',
    );
    // JSONL 首行不可重写；新增悬空外部关系必须显式迁移，不能偷偷改变 header。
    const external = new Set(
      (Array.isArray(old.header.externalReferences) ? old.header.externalReferences : []).map(
        (value) => canonical(value),
      ),
    );
    assert(
      (Array.isArray(next.header.externalReferences) ? next.header.externalReferences : []).every(
        (value) => external.has(canonical(value)),
      ),
      '新增外部引用需要迁移归档',
    );
    const records = old.revisions,
      observations = new Map<string, string>(),
      resources = old.resourceReceipts;
    const graph = old.graph,
      messages = new Set(old.messageIds);
    for (const values of old.observations.values())
      for (const value of values) observations.set(String(value.id), canonical(value));
    const freshRecords = new Set<string>(),
      freshObservations = new Set<string>(),
      freshResources = new Set<string>();
    let entries = 0;
    for await (const event of streamArchiveEvents(incoming, format, { ...next.state }, signal)) {
      signal?.throwIfAborted();
      if (event.type === 'commit') continue;
      const value = event.value;
      if (event.type === 'revision') {
        if (event.value.kind === 'message') messages.add(event.value.id);
        checkArchiveShape(`${value.kind}.schema.json`, value);
        const key = recordKey(value);
        if (records.has(key)) continue;
        graph.record(event.value);
        freshRecords.add(key);
      } else if (event.type === 'observation') {
        checkArchiveShape('common.schema.json#/$defs/observation', value);
        const previous = observations.get(String(value.id));
        if (previous !== undefined) {
          assert(previous === canonical(value), '相同观察 ID 的内容发生变化');
          continue;
        }
        freshObservations.add(String(value.id));
      } else {
        checkArchiveShape('archive.schema.json#/$defs/resource', value);
        const key = canonical(value);
        if (resources.has(key)) continue;
        if (value.status === 'saved')
          await archiveResource(
            resourceRoots?.target ?? dirname(target),
            String(value.path),
            value,
            resourceRoots?.incoming ?? dirname(incoming),
          );
        graph.resource(value);
        freshResources.add(key);
      }
      entries++;
    }
    graph.finish();
    const unchanged = async () =>
      assert(
        canonical(await fileDigest(target)) === canonical(fingerprint),
        '归档在读取后被其他程序修改，请重新读取后再试',
      );
    const include = (event: ArchiveEvent) =>
      event.type === 'revision'
        ? freshRecords.has(recordKey(event.value))
        : event.type === 'observation'
          ? freshObservations.has(String(event.value.id))
          : event.type === 'resource'
            ? freshResources.has(canonical(event.value))
            : false;
    await unchanged();
    if (format !== 'json') {
      if (entries || old.state.uncommittedTail) {
        const file = await open(target, 'r+');
        try {
          if (old.state.uncommittedTail) await file.truncate(old.state.committedBytes);
          if (entries) {
            let batchId = randomUUID(),
              digest = createHash('sha256'),
              count = 0;
            let position = old.state.committedBytes,
              sequence = BigInt(old.state.sequence),
              previous = old.state.previous;
            let compressedPending: string[] = [],
              compressedBytes = 0;
            const write = async (text: string) => {
              if (format === 'jsonl.gz') {
                compressedBytes += Buffer.byteLength(text);
                assert(compressedBytes <= 65 * 1024 * 1024, '压缩归档单块超过 65 MiB');
                compressedPending.push(text);
                return;
              }
              await writeBytes(Buffer.from(text));
            };
            const writeBytes = async (bytes: Buffer) => {
              let offset = 0;
              while (offset < bytes.length) {
                const result = await file.write(bytes, offset, bytes.length - offset, position);
                assert(result.bytesWritten > 0, '归档写入未取得进展');
                offset += result.bytesWritten;
                position += result.bytesWritten;
              }
            };
            const commit = async () => {
              if (!count) return;
              await file.sync();
              const value = {
                type: 'commit',
                batchId,
                sequence: String(++sequence),
                entries: count,
                sha256: digest.digest('hex'),
                previous,
              };
              await write(`${canonical(value)}\n`);
              if (format === 'jsonl.gz') {
                await writeBytes(await compressArchiveBlock(compressedPending.join('')));
                compressedPending = [];
                compressedBytes = 0;
              }
              await file.sync();
              previous = createHash('sha256').update(canonical(value)).digest('hex');
              batchId = randomUUID();
              digest = createHash('sha256');
              count = 0;
            };
            for await (const event of streamArchiveEvents(
              incoming,
              format,
              { ...next.state },
              signal,
            )) {
              if (event.type === 'commit') {
                await commit();
                continue;
              }
              if (!include(event)) continue;
              const line = {
                type: event.type,
                batchId,
                [event.type === 'revision' ? 'record' : event.type]: event.value,
              };
              const text = `${canonical(line)}\n`;
              digest.update(text);
              count++;
              await write(text);
            }
            await commit();
          }
          await file.sync();
        } finally {
          await file.close();
        }
      }
    } else if (entries) {
      let metadataBytes = 0n;
      for (const value of observations.values())
        metadataBytes += BigInt(Buffer.byteLength(value) + 1);
      for (const value of resources) metadataBytes += BigInt(Buffer.byteLength(value) + 1);
      for (const value of freshResources) metadataBytes += BigInt(Buffer.byteLength(value) + 1);
      for (const values of next.observations.values())
        for (const value of values)
          if (freshObservations.has(String(value.id)))
            metadataBytes += BigInt(Buffer.byteLength(canonical(value)) + 1);
      const space = await statfs(dirname(target), { bigint: true });
      assert(
        space.bavail * space.bsize >
          BigInt(fingerprint.size) +
            (await lstat(incoming, { bigint: true })).size +
            metadataBytes +
            65536n,
        '可用空间不足以原子更新归档，原文件保持不变',
      );
      const file = await open(temporary, 'wx', 0o600);
      let observationFile: Awaited<ReturnType<typeof open>> | undefined,
        resourceFile: Awaited<ReturnType<typeof open>> | undefined;
      try {
        observationFile = await open(observationPath, 'wx', 0o600);
        resourceFile = await open(resourcePath, 'wx', 0o600);
        const output = bufferedFileWriter(file),
          observationOutput = bufferedFileWriter(observationFile),
          resourceOutput = bufferedFileWriter(resourceFile);
        let recordCount = 0,
          observationCount = 0,
          resourceCount = 0;
        await output.write(`${canonical(old.header).slice(0, -1)},"records":[`);
        for (const [path, scan, fresh] of [
          [target, old, false],
          [incoming, next, true],
        ] as const)
          for await (const event of streamArchiveEvents(path, format, { ...scan.state }, signal)) {
            if (event.type === 'commit' || (fresh && !include(event))) continue;
            const text = canonical(event.value);
            if (event.type === 'revision') await output.write(`${recordCount++ ? ',' : ''}${text}`);
            else if (event.type === 'observation')
              await observationOutput.write(`${observationCount++ ? ',' : ''}${text}`);
            else await resourceOutput.write(`${resourceCount++ ? ',' : ''}${text}`);
          }
        await observationOutput.flush();
        await resourceOutput.flush();
        await observationFile.close();
        await resourceFile.close();
        await output.write('],"observations":[');
        await output.flush();
        for await (const chunk of createReadStream(observationPath)) await file.writeFile(chunk);
        await output.write('],"resources":[');
        await output.flush();
        for await (const chunk of createReadStream(resourcePath)) await file.writeFile(chunk);
        await output.write(']}\n');
        await output.flush();
        await file.sync();
      } finally {
        await Promise.all(
          [file, observationFile, resourceFile].map((handle) => handle?.close().catch(() => {})),
        );
      }
      await unchanged();
      await rename(temporary, target);
    }
    await syncArchiveDirectory(dirname(target));
    return { archiveId: String(old.header.archiveId), entries, messageCount: messages.size };
  } finally {
    const own = await lock.stat();
    await lock.close();
    const current = await lstat(lockPath).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return null;
    });
    if (current?.dev === own.dev && current.ino === own.ino) await unlink(lockPath);
    await Promise.all(
      [temporary, observationPath, resourcePath].map((path) => unlink(path).catch(() => {})),
    );
  }
}
