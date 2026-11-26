import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { Palette } from 'lucide-react';
import { ComponentAppearance } from '../../src/renderer/src/components/settings/ComponentAppearance';
import { Row, Toggle } from '../../src/renderer/src/components/settings/controls';
import { SegmentedControl } from '../../src/renderer/src/components/SegmentedControl';
import { ConversationList } from '../../src/renderer/src/im-template/template/conversationLists';
import { createTemplateDemoData } from '../support/templateDemoData';
import { ContentSelectionProvider } from '../../src/renderer/src/state/contentSelection';
import { CalendarDateField } from '../../src/renderer/src/components/CalendarDateField';
import { DialogHost, Modal } from '../../src/renderer/src/components/Dialog';
import { useDialog } from '../../src/renderer/src/components/Dialog.shared';
import { FormSelect, FormSuggestions } from '../../src/renderer/src/components/FormSelect';
import { FormRange } from '../../src/renderer/src/components/FormRange';
import { TaskProgressBar } from '../../src/renderer/src/components/tasks/TaskProgressBar';
import {
  componentStyles,
  ensureThemeInitialized,
  useThemeStore,
} from '../../src/renderer/src/state/theme';
import { contrastRatio } from '../../src/shared/theme_colors';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/im-template/styles.css';
import '../../src/renderer/src/styles/mobile-web.css';
import '../../src/renderer/src/styles/page-chrome.css';
import '../../src/renderer/src/styles/workspace-surfaces.css';
import '../../src/renderer/src/styles/hover-tooltip.css';
import '../../src/renderer/src/styles/workspace-menu.css';

ensureThemeInitialized();
Object.assign(window, { appearanceQa: { store: useThemeStore, componentStyles, contrastRatio } });
const demo = createTemplateDemoData();
const seed = demo.conversations.find((row) => row.type === 'direct')!;
const conversations = Array.from({ length: 200 }, (_, index) => ({
  ...seed,
  id: `fixture-${index}`,
}));

function FormControlsFixture() {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [sender, setSender] = useState('');
  const [date, setDate] = useState('2026-02-01');
  const [range, setRange] = useState(30);
  const [changes, setChanges] = useState(0);
  const [submit, setSubmit] = useState('');
  const [confirmation, setConfirmation] = useState(false);
  return (
    <section aria-label="共用表单控件">
      <DialogHost />
      <button type="button" className="weq-set-btn" onClick={() => setOpen(true)}>
        打开控件验证
      </button>
      <Modal open={open} onClose={() => setOpen(false)} labelledBy="fixture-form-title" width={310}>
        <h2 id="fixture-form-title">表单控件验证</h2>
        <form
          onChangeCapture={(event) => {
            if (event.target instanceof HTMLSelectElement) setChanges((count) => count + 1);
          }}
          onSubmit={(event) => {
            event.preventDefault();
            setSubmit(String(new FormData(event.currentTarget).get('choice')));
          }}
        >
          <label>
            选一个分组
            <FormSelect
              required
              name="choice"
              value={value}
              onChange={(event) => setValue(event.target.value)}
            >
              <option value="" data-placeholder disabled>
                请选择
              </option>
              <optgroup label="常用分组">
                <option value="first">甲组</option>
                <option value="disabled" disabled>
                  禁用分组
                </option>
                <option value="last">乙组</option>
              </optgroup>
            </FormSelect>
          </label>
          <button type="submit" className="weq-set-btn">
            提交分组
          </button>
          <output aria-label="提交结果">{submit}</output>
          <output aria-label="变更次数">{changes}</output>
        </form>
        <FormSuggestions
          aria-label="发送者"
          value={sender}
          onValueChange={setSender}
          options={[{ value: '10001', label: '小明' }]}
        />
        <CalendarDateField
          label="筛选日期"
          value={date}
          min="2026-02-01"
          max="2026-02-28"
          onChange={setDate}
        />
        <div>
          <label>
            <input type="checkbox" defaultChecked /> 我
          </label>
          <FormRange
            aria-label="清晰度"
            value={range}
            onChange={(event) => setRange(event.target.valueAsNumber)}
          />
          <TaskProgressBar label="已知进度" value={30} />
          <TaskProgressBar label="未知进度" />
        </div>
        <button
          type="button"
          className="weq-set-btn"
          onClick={() =>
            void useDialog.getState().confirm('验证确认框', '继续执行？').then(setConfirmation)
          }
        >
          打开确认
        </button>
        {confirmation && <span role="status">已确认</span>}
      </Modal>
    </section>
  );
}

function MixedToggleFixture() {
  const [values, setValues] = useState([true, false]);
  const all = values.every(Boolean);
  return (
    <section className="mixed-toggle-fixture" data-mixed-toggle-fixture>
      <Row
        label="全部提醒示例"
        control={
          <Toggle
            label="全部提醒示例"
            checked={all}
            mixed={!all && values.some(Boolean)}
            onChange={(value) => setValues(values.map(() => value))}
          />
        }
      />
      {['提醒子项 1', '提醒子项 2'].map((label, index) => (
        <Row
          key={label}
          label={label}
          control={
            <Toggle
              label={label}
              checked={values[index] ?? false}
              onChange={(next) => setValues(values.map((item, i) => (i === index ? next : item)))}
            />
          }
        />
      ))}
      <Row
        label="禁用的部分开启"
        control={<Toggle label="禁用的部分开启" checked mixed disabled onChange={() => {}} />}
      />
      <button type="button" className="weq-set-btn" onClick={() => setValues([true, false])}>
        重置开关示例
      </button>
    </section>
  );
}

function Fixture() {
  const [checked, setChecked] = useState(true);
  const [scope, setScope] = useState('all');
  return (
    <ContentSelectionProvider>
      <style>{`
        html,body,#root{height:auto;min-height:100%;margin:0;overflow:auto}
        .appearance-fixture{padding:24px;min-height:100vh;background:var(--weq-chat-bg);color:var(--weq-fg-primary)}
        .appearance-fixture h1{font-size:20px;margin:0 0 20px}
        .appearance-fixture h2{font-size:15px;margin:0 0 12px}
        .appearance-columns{display:grid;grid-template-columns:minmax(0,600px) minmax(0,360px);gap:24px;max-width:984px;margin:auto}
        .appearance-fixture .weq-settings-dialog{display:grid;grid-template-columns:minmax(0,1fr);width:auto;min-width:0;height:auto;gap:16px;background:transparent;border:0;border-radius:0;padding:0;box-shadow:none}
        .appearance-controls{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:16px 0}
        .appearance-fixture .weq-input{max-width:100%}
        .appearance-fixture .weq-directory-scope-menu{position:static;margin-top:16px}
        .appearance-fixture .weq-conversation-directory{height:320px}
        .appearance-fixture .appearance-list-shell{position:static;inset:auto;height:320px;isolation:auto}
        .appearance-fixture .appearance-list-shell .app-shell{display:block;height:320px;min-width:0}
        .appearance-fixture .modal-card{padding:16px;margin-top:16px}
        .appearance-fixture table{width:100%;margin-top:16px;font-size:13px}
        .appearance-fixture td{padding:12px;border-bottom:1px solid var(--weq-border-subtle)}
        .mixed-toggle-fixture{display:grid;gap:12px;margin:16px 0;min-width:0}
        .appearance-extended{display:grid;gap:12px;max-width:984px;margin:24px auto 0}
        .appearance-extended .weq-workspace-content{height:auto;overflow:visible}
        .appearance-extended .weq-workspace-page{height:auto;overflow:visible}
        .appearance-extended .weq-workspace-menu{position:static;width:100%;height:auto}
        .appearance-extended .weq-hover-tooltip{position:static;max-width:100%}
        .appearance-extended .weq-collection-filters{display:flex;flex-wrap:wrap}
        @media(max-width:720px){.appearance-fixture{padding:16px}.appearance-columns{grid-template-columns:minmax(0,1fr)}}
      `}</style>
      <main className="appearance-fixture">
        <div className="appearance-columns">
          <section>
            <h1>主题与布局</h1>
            <div className="weq-settings-dialog">
              <ComponentAppearance />
            </div>
          </section>
          <section>
            <h2>控件与会话</h2>
            <div className="appearance-controls">
              <button type="button" className="weq-set-btn weq-set-btn-primary">
                保存
              </button>
              <button type="button" className="weq-set-btn weq-set-btn-soft">
                取消
              </button>
              <button type="button" className="weq-set-btn weq-set-btn-danger">
                删除
              </button>
              <button type="button" className="weq-set-btn weq-set-btn-soft" disabled>
                不可用
              </button>
              <input className="weq-input" aria-label="搜索" placeholder="搜索聊天记录" />
            </div>
            <Row
              label="消息提醒"
              control={<Toggle checked={checked} onChange={setChecked} label="消息提醒" />}
            />
            <MixedToggleFixture />
            <div className="app-shell-root weq-web-shell appearance-list-shell">
              <div className="app-shell">
                <ConversationList
                  conversations={conversations}
                  activeConversationId="fixture-0"
                  preferences={{}}
                  drafts={{}}
                  user={demo.user}
                  onSelect={() => {}}
                />
              </div>
            </div>
            <div className="weq-directory-scope-menu">
              <button type="button">复制</button>
              <button type="button" aria-checked="true">
                查看详情
              </button>
            </div>
            <div className="modal-card">
              <h2>保存更改</h2>
              <div className="appearance-controls">
                <button type="button" className="primary-button">
                  确定
                </button>
                <button type="button" className="secondary-button">
                  取消
                </button>
              </div>
            </div>
            <table>
              <tbody>
                <tr>
                  <td>会话</td>
                  <td>200</td>
                </tr>
                <tr>
                  <td>消息</td>
                  <td>1200</td>
                </tr>
              </tbody>
            </table>
          </section>
        </div>
        <section className="appearance-extended">
          <FormControlsFixture />
          <SegmentedControl
            label="内容范围"
            value={scope}
            onChange={setScope}
            options={[
              { value: 'all', label: '全部内容' },
              { value: 'selected', label: '已选内容' },
              { value: 'disabled', label: '不可用', disabled: true },
            ]}
          />
          <div className="weq-workspace-content">
            <div className="weq-workspace-page">
              <section className="weq-collection-dialog">
                <header className="weq-collection-head">
                  <h2>收藏</h2>
                </header>
                <div className="weq-collection-filters" role="tablist" aria-label="收藏分类">
                  <button
                    type="button"
                    role="tab"
                    aria-selected="true"
                    className="weq-collection-chip is-active"
                  >
                    全部
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected="false"
                    className="weq-collection-chip"
                  >
                    图片
                  </button>
                </div>
                <label className="weq-collection-search">
                  <input aria-label="搜索收藏" placeholder="搜索收藏" />
                </label>
                <button type="button" className="weq-settings-nav-item is-active">
                  <Palette size={16} />
                  <span className="weq-settings-nav-label">主题与布局</span>
                </button>
                <article className="weq-dress-card">装扮预览</article>
              </section>
            </div>
          </div>
          <section className="weq-workspace-menu weq-modal">
            <header className="weq-workspace-menu-head">
              <h2>任务</h2>
            </header>
            <div className="weq-workspace-actions">
              <button type="button">导出</button>
              <button type="button" disabled>
                不可用
              </button>
            </div>
          </section>
          <div className="weq-hover-tooltip">保存到本机</div>
        </section>
      </main>
    </ContentSelectionProvider>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
