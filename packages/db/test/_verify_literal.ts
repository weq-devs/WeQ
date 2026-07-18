// 纯逻辑验证：复刻修复后的字面量渲染，确认 group(numeric) 用裸整数、剔除 u_，
// c2c(text) 保持引号。不碰真库、不碰你的配置。
function sqlStr(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}
function sqlLiteral(id: string, numeric: boolean): string | null {
  if (!numeric) return sqlStr(id);
  return /^[0-9]+$/.test(id) ? id : null;
}
function inList(ids: string[], numeric: boolean): string {
  return ids
    .map((id) => sqlLiteral(id, numeric))
    .filter((x): x is string => x !== null)
    .join(', ');
}

const groupIds = ['673646675', '1090396070', 'u_ShouldBeDropped'];
const c2cIds = ['u_mGIBTBW7gF4Wocw8zapc6w', 'u_abc'];

const g = inList(groupIds, true);
const c = inList(c2cIds, false);

console.log(`GROUP (numeric=true):  IN (${g})`);
console.log(`C2C   (numeric=false): IN (${c})`);
console.log('');
console.log(`group 含引号?  ${/'/.test(g) ? '❌ 还有引号' : '✅ 裸整数'}`);
console.log(`group 含 u_?   ${/u_/.test(g) ? '❌ 没剔除' : '✅ 已剔除'}`);
console.log(`group 含 673?  ${/673646675/.test(g) ? '✅' : '❌'}`);
