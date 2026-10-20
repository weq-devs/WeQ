import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExportTaskManager } from '../src/account/export/task_manager';
import type { MsgService } from '../src/account/msg';
import {
  describeExportOutput,
  exportOutputFileName,
  messageOutputFlags,
  type ExportOutputPlan,
} from '../src/account/export/output_shape';
const none = { avatar: false, transcribe: false, ocr: false, dress: false };
const all = { avatar: true, transcribe: true, ocr: true, dress: true };
const plain: ExportOutputPlan = {
  kind: 'messages',
  name: '合成会话',
  format: 'json',
  formats: ['json'],
};
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
describe('导出真实输出形态', () => {
  it.each(['README', 'report.TXT', 'data.tar.gz', '.profile', '附件.特殊后缀'])(
    '已有单文件保留原文件名 %s，不猜测或补写格式',
    (fileName) => {
      const output = describeExportOutput({ kind: 'file', name: fileName, fileName }, none);
      expect(output.kind).toBe('file');
      if (output.kind === 'file') expect(exportOutputFileName(output)).toBe(fileName);
    },
  );
  it('已有文件的路径只保留末段，长名称仍保留真实扩展名', () => {
    const output = describeExportOutput(
      { kind: 'file', name: '附件', fileName: `folder\\${'a'.repeat(200)}.PDF` },
      none,
    );
    if (output.kind !== 'file') throw new Error('应为单文件');
    expect(output.extension).toBe('PDF');
    expect(exportOutputFileName(output)).toMatch(/\.PDF$/);
    expect(exportOutputFileName(output)).not.toContain('folder');
  });
  it('实际建任务时再次拒绝多文件结果使用单文件位置，不留下任务或触发生成', async () => {
    const root = mkdtempSync(join(tmpdir(), 'weq-output-shape-'));
    roots.push(root);
    const manager = new ExportTaskManager({} as MsgService, root);
    const filePath = join(root, 'wrong.json');
    await expect(
      manager.startTask({
        kind: 'c2c',
        conv: 'u_peer',
        name: '合成多格式',
        format: 'json',
        formats: ['json', 'txt'],
        total: 0,
        savePolicy: { mode: 'before', filePath },
      }),
    ).rejects.toThrow(/多个文件/);
    expect(manager.listTasks()).toEqual([]);
    expect(existsSync(filePath)).toBe(false);
  });
  it('单格式纯消息是文件，多目标、多格式及 HTML 是目录', () => {
    expect(describeExportOutput(plain, none)).toEqual({
      kind: 'file',
      name: plain.name,
      extension: 'json',
    });
    expect(describeExportOutput({ ...plain, targetCount: 2 }, none)).toEqual({ kind: 'directory' });
    expect(describeExportOutput({ ...plain, formats: ['json', 'txt'] }, none)).toEqual({
      kind: 'directory',
    });
    expect(describeExportOutput({ ...plain, format: 'html', formats: ['html'] }, none)).toEqual({
      kind: 'directory',
    });
  });
  it('额外资源采用实际管线能力，不能仅按勾选项猜目录', () => {
    const plan = {
      ...plain,
      exportAvatar: true,
      media: { transcribeVoice: true, ocrImages: true },
      dress: { bubble: true },
    };
    expect(describeExportOutput(plan, none).kind).toBe('file');
    expect(describeExportOutput(plan, all).kind).toBe('directory');
    expect(messageOutputFlags(plan, none)).toMatchObject({
      wantAvatars: false,
      wantTranscribe: false,
      wantOcr: false,
      wantDress: false,
      isBundle: false,
    });
    expect(describeExportOutput({ ...plain, media: { exportMedia: true } }, none).kind).toBe(
      'directory',
    );
    expect(
      describeExportOutput({ ...plain, media: { mediaKinds: { sysface: true } } }, none).kind,
    ).toBe('directory');
  });
  it('名单按真实规范化格式判断，好友 vCard 为 vcf，成员回落 csv 后去重', () => {
    const plan: ExportOutputPlan = {
      kind: 'contacts',
      name: '名单',
      contactScope: 'friends',
      format: 'vcard',
      formats: ['vcard'],
    };
    expect(describeExportOutput(plan, all)).toEqual({
      kind: 'file',
      name: plan.name,
      extension: 'vcf',
    });
    expect(
      describeExportOutput({ ...plan, contactScope: 'group', formats: ['vcard', 'csv'] }, all),
    ).toEqual({ kind: 'file', name: plan.name, extension: 'csv' });
    expect(describeExportOutput({ ...plan, exportAvatar: true }, all).kind).toBe('directory');
    expect(describeExportOutput({ ...plan, exportAvatar: true }, none).kind).toBe('file');
  });
  it('有额外清单的整包固定为目录，缺少单文件格式或无效扩展名明确失败', () => {
    expect(
      describeExportOutput({ kind: 'bundle', name: '带资源清单的结果', formats: ['json'] }, all),
    ).toEqual({ kind: 'directory' });
    expect(() => describeExportOutput({ kind: 'file', name: '缺格式' }, none)).toThrow(/确定格式/);
    expect(() =>
      describeExportOutput({ ...plain, format: '../json', formats: undefined }, none),
    ).toThrow(/扩展名/);
    expect(() => describeExportOutput({ ...plain, targetCount: 0 }, none)).toThrow(/目标/);
  });
});
