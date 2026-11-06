import { describe, expect, it } from 'vitest';
import { raw } from '@weq/codec';
import { ElementWire } from '@weq/codec/proto/msg/element';
import { extractNativeProto } from '../src/account/export/archive_native';

const key = (tag: number, wire: number) => raw.writeVarint((BigInt(tag) << 3n) | BigInt(wire));
const text = (value: string) =>
  Buffer.concat([
    key(45101, 2),
    raw.writeVarint(BigInt(Buffer.byteLength(value))),
    Buffer.from(value),
  ]);
describe('原生字段提取', () => {
  it('已知文本不与未知字节重复保存，重复未知字段、错误 wire 和损坏尾部逐段保真', () => {
    const unknownA = Buffer.concat([key(999991, 0), raw.writeVarint(17n)]);
    const unknownB = Buffer.concat([key(999991, 2), raw.writeVarint(2n), Buffer.from([255, 0])]);
    const wrongWire = Buffer.concat([key(45101, 0), raw.writeVarint(18n)]);
    const tail = Buffer.from([128]);
    const bytes = Buffer.concat([text('正文'), unknownA, unknownB, wrongWire, tail]);
    const extracted = extractNativeProto(bytes, ElementWire, 'synthetic-source', '/body');
    expect(
      extracted.cells
        .filter((cell) => cell.semantic[0] === 'textContent')
        .map((cell) => cell.value),
    ).toEqual(['正文']);
    expect(
      extracted.residuals.map((value) =>
        Buffer.from(String((value.value as { value: string }).value), 'base64'),
      ),
    ).toEqual([unknownA, unknownB, wrongWire, tail]);
    expect(extracted.residuals.map((value) => value.reason)).toEqual([
      'unknown-field',
      'unknown-field',
      'wire-type-mismatch',
      'unconsumed-tail',
    ]);
    expect(extracted.residuals[0]?.path).not.toBe(extracted.residuals[1]?.path);
  });
  it('重复的已知标量均保留读取值，不只保存最后一次覆盖结果', () => {
    const extracted = extractNativeProto(
      Buffer.concat([text('首次'), text('再次')]),
      ElementWire,
      'synthetic-source',
      '/body',
    );
    expect(extracted.cells.map((cell) => cell.value)).toEqual(['首次', '再次']);
    expect(extracted.residuals).toEqual([]);
  });
});
