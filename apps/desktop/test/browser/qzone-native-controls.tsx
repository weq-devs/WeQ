import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MediaPreview } from '../../src/renderer/src/components/MediaPreview';
import '../../src/renderer/src/styles/index.css';

async function createClip(): Promise<string> {
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 240;
  const context = canvas.getContext('2d')!;
  const stream = canvas.captureStream(20);
  const audio = new AudioContext();
  const destination = audio.createMediaStreamDestination();
  const oscillator = audio.createOscillator();
  oscillator.connect(destination);
  oscillator.start();
  await audio.resume();
  for (const track of destination.stream.getAudioTracks()) stream.addTrack(track);
  const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8,opus' });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => chunks.push(event.data);
  const stopped = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve();
  });
  recorder.start();
  try {
    for (let frame = 0; frame < 20; frame++) {
      context.fillStyle = '#176b53';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = '#f0d332';
      context.fillRect(frame * 10, 80, 60, 80);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    recorder.stop();
    await stopped;
    return URL.createObjectURL(new Blob(chunks, { type: 'video/webm' }));
  } finally {
    for (const track of stream.getTracks()) track.stop();
    oscillator.stop();
    await audio.close();
  }
}

function Scene({ src }: { src: string }) {
  const [live, setLive] = useState<boolean | null>(null);
  return (
    <main>
      <button type="button" onClick={() => setLive(true)}>
        打开实况
      </button>
      <button type="button" onClick={() => setLive(false)}>
        打开视频
      </button>
      {live !== null ? (
        <MediaPreview
          items={[{ key: 'fixture', kind: 'video', src, isLivePhoto: live }]}
          initialIndex={0}
          onClose={() => setLive(null)}
        />
      ) : null}
    </main>
  );
}

void createClip().then((src) =>
  createRoot(document.getElementById('root')!).render(<Scene src={src} />),
);
