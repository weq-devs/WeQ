import { expect, it } from 'vitest';
import { sourceSearchCommand } from '../src/main/source_search_disk_guard';
it('resolves external symlinks to live mount roots without exposing credentials in argv', () => {
  const command = sourceSearchCommand(
    '/electron',
    ['/worker'],
    ['/local/link/db', '/Volumes/f name/cache'],
    {
      platform: 'darwin',
      guardPath: '/guard.py',
      exists: () => true,
      physicalPath: (path) => (path.startsWith('/local/') ? '/Volumes/f name/qq/db' : path),
    },
  );
  expect(command.args).toEqual([
    '/guard.py',
    '--name',
    'weq-search-owned-reader',
    '--once',
    '--root',
    '/Volumes/f name',
    '--',
    '/electron',
    '/worker',
  ]);
});
it('keeps SSD-only and portable installations independent of the private host guard', () => {
  expect(
    sourceSearchCommand('/electron', ['/worker'], ['/local/db'], {
      platform: 'darwin',
      exists: () => true,
      physicalPath: (path) => path,
    }),
  ).toEqual({ executable: '/electron', args: ['/worker'] });
  expect(
    sourceSearchCommand('/electron', ['/worker'], ['/Volumes/f/db'], {
      platform: 'darwin',
      exists: () => false,
    }),
  ).toEqual({ executable: '/electron', args: ['/worker'] });
});
