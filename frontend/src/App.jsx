import { useEffect, useState } from 'react';
import SignalDashboard from './components/SignalDashboard';
import { fetchSignals } from './services/api';

function App() {
  const [signals, setSignals] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetchSignals()
      .then(setSignals)
      .catch(err => setError(err.message));
  }, []);

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-branding">
          <img className="app-logo" src="/logo-1.png" alt="KachingScanner logo" />
          <div>
            <h1>KachingScanner Forex AI</h1>
            <p>Live signal feed for stop loss, take profit, and entry updates.</p>
          </div>
        </div>
      </header>
      {error && <div className="app-error">{error}</div>}
      <SignalDashboard initialSignals={signals} />
    </div>
  );
}

export default App;
