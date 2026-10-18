import type { GeneratedContentSnapshot } from '../generated_content';
import { writeFileStream, writeTable, type Col, type TableFormat } from './table_writer';
import type { GeneratedResourceManifest } from './generated_resources';

export const GENERATED_EXPORT_FORMATS = ['json', 'jsonl', 'txt', 'csv', 'xlsx'] as const;
export type GeneratedExportFormat = (typeof GENERATED_EXPORT_FORMATS)[number];
type Row = GeneratedContentSnapshot['messages'][number];

function messageResources(
  resources: GeneratedResourceManifest,
  id: string,
): GeneratedResourceManifest {
  const entries = resources.entries.filter((entry) => entry.messageIds.includes(id));
  return { ...resources, complete: entries.every((entry) => entry.status === 'copied'), entries };
}

/** 本地生成记录使用独立 schema，绝不伪装成 QQ/ChatLab 服务器消息。 */
export async function writeGeneratedContent(
  snapshot: GeneratedContentSnapshot,
  format: TableFormat,
  path: string,
  resources?: GeneratedResourceManifest,
): Promise<void> {
  const { messages, ...source } = snapshot;
  if (format === 'json') {
    await writeFileStream(
      path,
      JSON.stringify(
        { schema: 'weq-generated-content/1', ...snapshot, ...(resources ? { resources } : {}) },
        null,
        2,
      ),
    );
    return;
  }
  if (format === 'jsonl') {
    const lines = messages.map((message) =>
      JSON.stringify({
        schema: 'weq-generated-message/1',
        ...source,
        message,
        ...(resources ? { resources: messageResources(resources, message.id) } : {}),
      }),
    );
    await writeFileStream(path, lines.length ? `${lines.join('\n')}\n` : '');
    return;
  }
  const cols: Array<Col<Row>> = [
    { key: 'origin', header: '来源', get: () => 'local-generated' },
    { key: 'kind', header: '对话种类', get: () => snapshot.target.kind },
    { key: 'ownerId', header: '对象身份', get: () => snapshot.target.ownerId },
    { key: 'sessionId', header: '会话身份', get: () => snapshot.target.sessionId ?? '' },
    {
      key: 'legacy',
      header: '旧版记录',
      get: () => (snapshot.target.sessionId === null ? 'true' : 'false'),
    },
    { key: 'title', header: '对话名称', get: () => `${snapshot.title} · ${snapshot.sessionTitle}` },
    { key: 'id', header: '消息身份', get: (row) => row.id },
    { key: 'role', header: '角色', get: (row) => row.role ?? row.senderKind ?? '' },
    { key: 'senderId', header: '发言者身份', get: (row) => row.senderId ?? '' },
    { key: 'ts', header: '原始时间戳（毫秒）', get: (row) => row.ts },
    { key: 'text', header: '正文', get: (row) => row.text },
    ...(resources
      ? [
          {
            key: 'resources',
            header: '资源（包内相对路径及状态）',
            get: (row: Row) =>
              JSON.stringify(
                resources.entries.filter((entry) => entry.messageIds.includes(row.id)),
              ),
          },
        ]
      : []),
    { key: 'details', header: '完整记录（JSON）', get: (row) => JSON.stringify(row) },
  ];
  await writeTable(format, cols, messages, path, '本地生成对话');
}
