import type { LogLevel } from './logger';

export const levelColors: Record<LogLevel, number>;
export function formatConsoleHeader(
  level: LogLevel,
  message: string,
  scope: string,
  options: { now: number; color: boolean },
): string;
