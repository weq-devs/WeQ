import { taskDisplayTitle, taskInlineText, type TaskDisplay } from '@weq/service/task-display';
import { NumericText } from '../NumericText';

export function TaskName({ display }: { display: TaskDisplay }) {
  const subject = taskInlineText(display.subject ?? '');
  const extension = display.fileName ? /\.[a-z\d]{1,12}$/i.exec(subject)?.[0] : undefined;
  if (extension) {
    return (
      <span className="weq-task-file-name">
        <span>{display.action}</span>
        <span className="weq-task-file-subject">
          <span className="weq-task-file-stem">{subject.slice(0, -extension.length)}</span>
          <span className="weq-task-file-extension">{extension}</span>
        </span>
      </span>
    );
  }
  return display.numericSubject && subject ? (
    <>
      {display.action} · <NumericText>{subject}</NumericText>
    </>
  ) : (
    taskDisplayTitle(display)
  );
}

export function TaskOriginalName({ name, display }: { name: string; display: TaskDisplay }) {
  const original = display.fileName ? (display.subject ?? name) : name;
  if (original.length <= 40 && (!display.subject || display.subject === original)) return null;
  return (
    <details className="weq-task-original-name">
      <summary>完整名称</summary>
      <p>{original}</p>
    </details>
  );
}
