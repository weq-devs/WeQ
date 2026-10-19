import { Modal } from './Dialog';
import { SaveResultLocation } from '../views/export/SaveResultLocation';
import '../styles/server-save-prompt.css';

export function ServerSavePrompt({
  name,
  onChoose,
}: {
  name: string;
  onChoose: (directory: string | null) => void;
}) {
  return (
    <Modal
      title="保存到服务器"
      width={440}
      centered
      className="weq-server-save-dialog"
      layerClassName="weq-server-save-layer"
      onClose={() => onChoose(null)}
    >
      <SaveResultLocation name={name} onChoose={onChoose} onCancel={() => onChoose(null)} />
    </Modal>
  );
}
