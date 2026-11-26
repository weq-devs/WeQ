import { z } from 'zod/v3';

export const messageExportFormatInput = z.enum([
  'json',
  'jsonl',
  'jsonl.gz',
  'chatlab.json',
  'chatlab.jsonl',
  'txt',
  'csv',
  'xlsx',
  'html',
]);
