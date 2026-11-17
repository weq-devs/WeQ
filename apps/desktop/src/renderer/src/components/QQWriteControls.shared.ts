import '../styles/qq-write.css';

export function qqWriteNeedsConfirmation(policy: number): boolean {
  return policy === 2 || policy === 3;
}
