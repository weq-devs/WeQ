import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DialogHost } from '../../src/renderer/src/components/Dialog';
import { NewCloneModal } from '../../src/renderer/src/views/agentlab/NewCloneModal';
import { NewGroupModal } from '../../src/renderer/src/views/agentlab/NewGroupModal';
import { useThemeStore } from '../../src/renderer/src/state/theme';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/styles/mobile-web.css';

const params = new URLSearchParams(location.search);
const names = ['合成好友', '很长的好友名称'.repeat(12), 'LongUnbrokenName'.repeat(12)];
const buddies = Array.from({ length: params.has('empty') ? 0 : 40 }, (_, index) => ({
  uid: `u_synthetic_${index}`,
  uin: String(10001 + index),
  label: names[index] ?? `合成好友 ${index + 1}`,
}));
Object.assign(window, { cloneModalTheme: useThemeStore });

function Fixture() {
  const [closed, setClosed] = useState(false);
  const [result, setResult] = useState('');
  const close = () => setClosed(true);
  return (
    <>
      <output>{result}</output>
      {!closed &&
        (params.has('group') ? (
          <NewGroupModal
            personas={buddies.map((buddy) => ({
              id: buddy.uid,
              name: buddy.label,
              uin: buddy.uin,
              sourceTitle: '合成来源',
            }))}
            onClose={close}
            onCreate={(input) => setResult(JSON.stringify(input))}
          />
        ) : (
          <NewCloneModal
            buddies={buddies}
            flatModels={{ chat: [], embedding: [], vision: [] }}
            onClose={close}
            onStart={(args) => setResult(args.meta.name)}
          />
        ))}
      <DialogHost />
    </>
  );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
