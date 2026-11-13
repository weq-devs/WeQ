import { createRoot } from 'react-dom/client';
import { ContactRow } from '../../src/renderer/src/components/contactProfile/ContactRow';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/styles/contact-card.css';
import '../../src/renderer/src/styles/contact-workspace.css';
import '../../src/renderer/src/styles/friend-clue.css';

const text = '第一行文字\n第二行文字\n第三行文字';
const image =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const privileges = Array.from({ length: 28 }, (_, index) => `privilege-${index}`);

createRoot(document.getElementById('root')!).render(
  <main
    className="weq-contact-card weq-contact-profile-v2"
    style={{
      width: 'min(440px, calc(100vw - 32px))',
      margin: '16px auto',
      padding: 16,
      maxHeight: 'none',
    }}
  >
    <ContactRow label="普通文字" value={text} />
    <ContactRow label="复制文字" value={text} copyValue={text} />
    <ContactRow label="编辑文字" value={text} onActivate={() => {}} />
    <ContactRow label="互动标识">
      <div className="weq-profile-tags">
        {['友谊的小船', '友谊的巨轮', '聊天之火', '幸运字符', '亲密互动'].map((name) => (
          <button type="button" className="weq-contact-value" key={name}>
            <img src={image} alt="" width={18} height={18} />
            {name}
          </button>
        ))}
      </div>
    </ContactRow>
    <ContactRow label="来源群">
      <button type="button" className="weq-friend-source-group">
        <img src={image} alt="" />
        <span>{text}</span>
      </button>
    </ContactRow>
    <ContactRow label="QQ 秀">
      <div className="weq-contact-qqshow">
        <img src={image} alt="合成图片" />
      </div>
    </ContactRow>
    <ContactRow label="已开通特权">
      <div className="weq-profile-privileges">
        {privileges.map((id) => (
          <img key={id} className="weq-profile-privilege" src={image} alt="" />
        ))}
      </div>
    </ContactRow>
  </main>,
);
