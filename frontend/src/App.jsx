import { useState } from 'react';
import HomePage from './pages/HomePage.jsx';
import ReceivePage from './pages/ReceivePage.jsx';
import SendDialog from './components/SendDialog.jsx';

export default function App() {
  const [screen, setScreen] = useState('home'); // "home" | "receive"
  const [dialog, setDialog] = useState(null); // null | "upload" | "peer"
  const [code, setCode] = useState('');
  const [kind, setKind] = useState('uploaded'); // "uploaded" | "peer"

  return (
    <div className="frame">
      <div className="scroller">
        {screen === 'home' ? (
          <HomePage
            code={code}
            kind={kind}
            onCodeChange={setCode}
            onKindChange={setKind}
            onUpload={() => setDialog('upload')}
            onPeerShare={() => setDialog('peer')}
            onReceive={() => setScreen('receive')}
          />
        ) : (
          <ReceivePage code={code} kind={kind} onBack={() => setScreen('home')} />
        )}
      </div>
      {dialog && <SendDialog key={dialog} mode={dialog} onClose={() => setDialog(null)} />}
    </div>
  );
}
