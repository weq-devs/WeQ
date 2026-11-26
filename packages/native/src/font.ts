import type { ConvertFontOptions, NtHelperBinding } from './types';

export async function convertNativeFont(
  native: Pick<NtHelperBinding, 'convertFont' | 'convertFontAsync'>,
  input: string,
  output: string,
  options?: ConvertFontOptions,
): Promise<string> {
  if (native.convertFontAsync) return native.convertFontAsync(input, output, options);
  return native.convertFont(input, output, options);
}
