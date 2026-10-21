import { useState } from 'react';
import { X, FolderDown } from 'lucide-react';

export function SaveResultLocation({
  name,
  onChoose,
  onCancel,
}: {
  name: string;
  onChoose: (subdirectory: string) => void;
  onCancel: () => void;
}) {
  const [directory, setDirectory] = useState('');
  return (
    <form
      className="weq-save-result-location"
      onSubmit={(event) => {
        event.preventDefault();
        onChoose(directory);
      }}
    >
      <h3>保存「{name}」到服务器</h3>
      <label>
        服务器导出目录内的子文件夹
        <input
          aria-label="服务器保存子目录"
          value={directory}
          placeholder="当前导出目录"
          onChange={(event) => setDirectory(event.target.value)}
        />
      </label>
      <div>
        <button type="button" onClick={onCancel}>
          <X size={16} />
          取消
        </button>
        <button type="submit">
          <FolderDown size={16} />
          保存
        </button>
      </div>
    </form>
  );
}
