export type SourceTokenizer = 'trigram' | 'pinyin0';
interface Token {
  value: string;
  quoted?: boolean;
  punctuation?: boolean;
}
export interface SourceFtsContract {
  tokenizer: SourceTokenizer;
  columns: string[];
}

/** 只解析 FTS5 的平面参数，不把引号中的列名或注释当作配置项。 */
export function sourceFtsContract(sql: string, table: string): SourceFtsContract | null {
  const tokens: Token[] = [];
  for (let index = 0; index < sql.length; ) {
    const char = sql[index]!;
    if (/\s/.test(char)) {
      index++;
      continue;
    }
    if (sql.startsWith('--', index)) {
      const end = sql.indexOf('\n', index);
      index = end < 0 ? sql.length : end + 1;
      continue;
    }
    if (sql.startsWith('/*', index)) {
      const end = sql.indexOf('*/', index + 2);
      if (end < 0) return null;
      index = end + 2;
      continue;
    }
    if (["'", '"', '`', '['].includes(char)) {
      const end = char === '[' ? ']' : char;
      let value = '',
        closed = false;
      index++;
      while (index < sql.length) {
        if (sql[index] === end) {
          if (end !== ']' && sql[index + 1] === end) {
            value += end;
            index += 2;
            continue;
          }
          index++;
          closed = true;
          break;
        }
        value += sql[index++];
      }
      if (!closed) return null;
      tokens.push({ value, quoted: true });
      continue;
    }
    if ('(),=;'.includes(char)) {
      tokens.push({ value: char, punctuation: true });
      index++;
      continue;
    }
    const start = index;
    while (index < sql.length && !/\s/.test(sql[index]!) && !'(),=;\'"`['.includes(sql[index]!))
      index++;
    if (start === index) return null;
    tokens.push({ value: sql.slice(start, index) });
  }
  const using = tokens.findIndex(
    (token, index) =>
      !token.quoted &&
      token.value.toUpperCase() === 'USING' &&
      tokens[index + 1]?.value.toLowerCase() === 'fts5' &&
      tokens[index + 2]?.value === '(',
  );
  if (using < 0) return null;
  const options = new Map<string, string>(),
    columns = new Map<string, boolean>();
  let argument: Token[] = [],
    ended = false;
  for (const token of tokens.slice(using + 3)) {
    if (token.punctuation && [',', ')'].includes(token.value)) {
      if (argument.length === 3 && argument[1]?.punctuation && argument[1].value === '=') {
        const key = argument[0]!.value.toLowerCase();
        if (options.has(key)) return null;
        options.set(key, argument[2]!.value);
      } else if (
        argument.length === 1 ||
        (argument.length === 2 &&
          !argument[1]?.quoted &&
          argument[1]?.value.toUpperCase() === 'UNINDEXED')
      ) {
        const name = argument[0]!.value;
        if (columns.has(name)) return null;
        columns.set(name, argument.length === 1);
      } else return null;
      argument = [];
      if (token.value === ')') {
        ended = true;
        break;
      }
    } else argument.push(token);
  }
  if (
    !ended ||
    options.get('content')?.toLowerCase() !== table.toLowerCase() ||
    (options.get('detail') ?? 'full') !== 'full'
  )
    return null;
  if (options.has('content_rowid') && !['rowid', '41700'].includes(options.get('content_rowid')!))
    return null;
  if (columns.get('41701') !== true || columns.get('41702') !== true) return null;
  for (const name of ['41700', '40001', '40010', '40021', '40020', '40050', '40003', '40027'])
    if (!columns.has(name)) return null;
  const setting = options.get('tokenize');
  const tokenizer =
    setting === 'trigram' ? 'trigram' : setting === 'pinyin_letter 0' ? 'pinyin0' : null;
  return tokenizer ? { tokenizer, columns: [...columns.keys()] } : null;
}
