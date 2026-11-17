import { useEffect, useState } from 'react';
import HomePage from './pages/HomePage.jsx';
import ReceivePage from './pages/ReceivePage.jsx';
import SendDialog from './components/SendDialog.jsx';
import { matchRoute, navigate, sharePath, usePath } from './lib/router.js';

export default function App() {
  const route = matchRoute(usePath());
  const [dialog, setDialog] = useState(null); // null | "upload" | "peer"
  const [code, setCode] = useState(''); // the code typed on the home page
  const [kind, setKind] = useState('uploaded'); // "uploaded" | "peer"

  useEffect(() => {
    if (route.name === 'unknown') navigate('/', { replace: true });
  }, [route.name]);

  return (
    <div className="frame">
      <div className="scroller">
        {route.name === 'receive' ? (
          <ReceivePage key={`${route.kind}/${route.code}`} code={route.code} kind={route.kind} onBack={() => navigate('/')} />
        ) : (
          <HomePage
            code={code}
            kind={kind}
            onCodeChange={setCode}
            onKindChange={setKind}
            onUpload={() => setDialog('upload')}
            onPeerShare={() => setDialog('peer')}
            onReceive={() => navigate(sharePath(code, kind))}
          />
        )}
      </div>
      {dialog && <SendDialog key={dialog} mode={dialog} onClose={() => setDialog(null)} />}
    </div>
  );
}
