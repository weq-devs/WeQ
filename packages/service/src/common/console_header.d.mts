import type { LogLevel } from './logger';

export const levelColors: Record<LogLevel, number>;
export function terminalColor(stream: 'stdout' | 'stderr', env?: NodeJS.ProcessEnv): boolean;
export function formatConsoleHeader(
  level: LogLevel,
  message: string,
  scope: string,
  options: { now: number; color: boolean },
): string;
