import { Modal } from './Dialog';
import { useId } from 'react';
import { SaveResultLocation } from '../views/export/SaveResultLocation';
import '../styles/server-save-prompt.css';

export function ServerSavePrompt({
  name,
  onChoose,
  portalTarget,
}: {
  name: string;
  onChoose: (directory: string | null) => void;
  portalTarget?: Element | null;
}) {
  const titleId = useId();
  return (
    <Modal
      title="保存到服务器"
      labelledBy={titleId}
      width={440}
      centered
      className="weq-server-save-dialog"
      layerClassName="weq-server-save-layer"
      onClose={() => onChoose(null)}
      portalTarget={portalTarget}
    >
      <SaveResultLocation
        name={name}
        headingId={titleId}
        onChoose={onChoose}
        onCancel={() => onChoose(null)}
      />
    </Modal>
  );
}
