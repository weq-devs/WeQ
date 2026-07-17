import { decodeBody } from '../src/msg/util';

// 参考样本头部（截断的 tipJson，仅测结构）
const ref = '82f613ab03c8fc15d3a5efcfc6cff0ab6ad0fc1508d8fc1511fac81785037b22616c69676e223a2263656e746572227d80c9170088c917e11298c91700';
const mine = '82f613c302c8fc15d3a5efcfc6cff0ab6ad0fc1508d8fc1511fac8179a027b22616c69676e223a2263656e746572227d80c9170088c917e11298c91700';

// 逐字节手动解析外层 varint，定位差异
function parseLen(hex: string): void {
  const b = Buffer.from(hex, 'hex');
  // 82f613 = 3B tag; 之后是 varint
  let pos = 3;
  let val = 0, shift = 0;
  while (pos < b.length) {
    const c = b[pos]!; val |= (c & 0x7f) << shift; pos++;
    if ((c & 0x80) === 0) break; shift += 7;
  }
  const declared = val;
  const actual = b.length - pos; // pos 现在指向 element 内容开始
  console.log(`  外层声明长度=${declared}  实际剩余=${actual}  ${declared === actual ? '✅' : '❌ 差 ' + (actual - declared)}`);
}

console.log('REF:');
parseLen(ref);
console.log('  decode kinds:', JSON.stringify(decodeBody(Buffer.from(ref, 'hex')).map((e: any) => e.kind)));
console.log('MINE:');
parseLen(mine);
console.log('  decode kinds:', JSON.stringify(decodeBody(Buffer.from(mine, 'hex')).map((e: any) => e.kind)));
