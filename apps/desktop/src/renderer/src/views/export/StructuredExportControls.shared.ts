import type { ExportExtraOptions } from '@weq/service/export-content';
import '../../styles/structured-export.css';
import '../../styles/export-content-selector.css';

export interface StructuredExportOptions {
  extra?: ExportExtraOptions;
  profile?: 'basic' | 'full';
  incrementalSupport?: boolean;
}
export function structuredExportOptions(
  _options: StructuredExportOptions,
  formats: readonly string[],
  chatlab = false,
): StructuredExportOptions & { profile: 'full'; incrementalSupport: boolean } {
  return {
    ...(_options.extra ? { extra: _options.extra } : {}),
    profile: 'full',
    incrementalSupport:
      !chatlab &&
      formats.some((format) => format === 'json' || format === 'jsonl' || format === 'jsonl.gz'),
  };
}
