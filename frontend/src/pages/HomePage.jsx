import Icon from '../components/Icon.jsx';
import CodeInput from '../components/CodeInput.jsx';
import SegmentedControl from '../components/SegmentedControl.jsx';
import RecentShares from '../components/RecentShares.jsx';

const KINDS = [{ value: 'uploaded', label: 'Uploaded' }, { value: 'peer', label: 'Peer' }];

export default function HomePage({ code, kind, onCodeChange, onKindChange, onUpload, onPeerShare, onReceive }) {
  const incomplete = code.length < 6;
  const receive = () => { if (!incomplete) onReceive(); };
  return (
    <main className="home">
      <section className="g">
        <div className="rule" />
        <div className="lab"><h2 className="xl">Send</h2></div>
        <div className="con">
          <button className="act act-primary m4" onClick={onUpload}><span>Upload</span><Icon name="upload" size={28} /></button>
          <button className="act m4" onClick={onPeerShare}><span>Peer share</span><Icon name="arrow-left-right" size={28} /></button>
        </div>
      </section>

      <section className="g">
        <div className="rule" />
        <div className="lab"><h2 className="xl">Receive</h2></div>
        <div className="con">
          <div className="field m4">
            <label>Code</label>
            <CodeInput value={code} onChange={onCodeChange} onEnter={receive} />
          </div>
          <div className="field m4">
            <label>Shared as</label>
            <SegmentedControl name="receive-kind" options={KINDS} value={kind} onChange={onKindChange} />
          </div>
          <button className="btn btn-ink btn-tall m4" disabled={incomplete} onClick={receive}>
            <span>Receive</span><Icon name="arrow-right" size={24} invert />
          </button>
        </div>
      </section>

      <RecentShares />
    </main>
  );
}
