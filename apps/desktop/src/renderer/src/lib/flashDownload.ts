import { client } from '../trpc/client';

type DownloadInput = Parameters<typeof client.account.flashDownloadOutput.mutate>[0];

export async function downloadFlashToDevice(
  input: DownloadInput,
  isCurrent: () => boolean,
): Promise<void> {
  const { url } = await client.account.flashDownloadOutput.mutate(input);
  if (!isCurrent()) return;
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = '';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}
