import { ArrowLeft, ChevronRight } from 'lucide-react';
import '../styles/group-resource-navigation.css';

/** 相册与文件共用窗口内目录导航，不调用主界面的页面返回栈。 */
export function GroupResourceNavigation({
  label,
  items,
  onSelect,
  onBack,
}: {
  label: string;
  items: Array<{ id: string; name: string }>;
  onSelect: (index: number) => void;
  onBack: () => void;
}) {
  return (
    <nav className="group-file-toolbar weq-group-resource-navigation" aria-label={label}>
      <button
        type="button"
        className="icon-button"
        title="返回上级目录"
        aria-label="返回上级目录"
        disabled={items.length < 2}
        onClick={onBack}
      >
        <ArrowLeft size={16} />
      </button>
      <div className="group-file-crumbs">
        {items.map((item, index) => (
          <span key={item.id} className="weq-group-resource-crumb">
            {index ? <ChevronRight size={13} aria-hidden /> : null}
            <button
              type="button"
              className="group-file-crumb"
              aria-current={index === items.length - 1 ? 'page' : undefined}
              title={item.name}
              onClick={() => onSelect(index)}
            >
              {item.name}
            </button>
          </span>
        ))}
      </div>
    </nav>
  );
}
