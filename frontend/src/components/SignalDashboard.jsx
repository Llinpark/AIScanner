import { useEffect, useState } from 'react';
import { io } from 'socket.io-client';

const SOCKET_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:4000';

export default function SignalDashboard({ initialSignals }) {
  const [signals, setSignals] = useState(initialSignals || []);

  useEffect(() => {
    const socket = io(SOCKET_URL);

    socket.on('signal:update', newSignal => {
      setSignals(prev => [newSignal, ...prev].slice(0, 50));
    });

    return () => {
      socket.disconnect();
    };
  }, []);

  return (
    <div className="dashboard-card">
      <h2>Recent Trade Signals</h2>
      <div className="signal-list">
        {signals.length === 0 ? (
          <div className="signal-empty">No signals available.</div>
        ) : (
          signals.map(signal => (
            <div key={signal._id || signal.timestamp} className="signal-item">
              <div className="signal-header">
                <span>{signal.symbol}</span>
                <strong>{signal.direction.toUpperCase()}</strong>
              </div>
              <div className="signal-row">
                <span>Entry: {signal.entry.toFixed(5)}</span>
                <span>SL: {signal.stop_loss.toFixed(5)}</span>
              </div>
              <div className="signal-row">
                <span>TP1: {signal.take_profit_1.toFixed(5)}</span>
                <span>TP2: {signal.take_profit_2.toFixed(5)}</span>
                <span>TP3: {signal.take_profit_3.toFixed(5)}</span>
              </div>
              <div className="signal-footer">
                <small>Confidence: {(signal.confidence * 100).toFixed(0)}%</small>
                <span>{signal.notes}</span>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
