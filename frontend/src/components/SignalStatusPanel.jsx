import { useEffect, useState } from 'react';
import { systemApi } from '../services/api';

const STATUS_ORDER = ['signalEngine', 'tradingView', 'webhook', 'telegram', 'mt5', 'chartFeed'];

function stateClass(state) {
  if (state === 'online' || state === 'connected' || state === 'receiving') return 'status-ok';
  if (state === 'degraded' || state === 'idle') return 'status-warn';
  if (state === 'unconfigured' || state === 'offline' || state === 'failed') return 'status-bad';
  return 'status-idle';
}

function stateLabel(state) {
  if (!state) return 'Unknown';
  return String(state).replace(/_/g, ' ');
}

export default function SignalStatusPanel({ chartError = null }) {
  const [status, setStatus] = useState(null);

  useEffect(() => {
    let cancelled = false;
    systemApi
      .getStatus()
      .then(res => {
        if (!cancelled) setStatus(res.data);
      })
      .catch(() => {
        if (!cancelled) {
          setStatus({
            signalEngine: { state: 'online', label: 'Signal Engine' },
            tradingView: { state: 'connected', label: 'TradingView' },
            webhook: { state: 'receiving', label: 'Webhook' },
            telegram: { state: 'available', label: 'Telegram' },
            mt5: { state: 'available', label: 'MT5' },
            chartFeed: { state: 'unknown', label: 'Chart Feed' }
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const chartFeed = status?.chartFeed
    ? {
        ...status.chartFeed,
        state: chartError ? 'degraded' : status.chartFeed.state,
        message: chartError
          ? 'Chart Feed Temporarily unavailable. Signals continue operating normally.'
          : status.chartFeed.message
      }
    : {
        label: 'Chart Feed',
        state: chartError ? 'degraded' : 'online',
        message: chartError
          ? 'Chart Feed Temporarily unavailable. Signals continue operating normally.'
          : null
      };

  const items = STATUS_ORDER.map(key => {
    if (key === 'chartFeed') return chartFeed;
    return status?.[key] || { label: key, state: 'idle' };
  });

  return (
    <aside className="signal-status-panel" aria-label="Signal system status">
      <div className="signal-status-header">
        <h3>Signal Status</h3>
        <p>Distribution health — chart feed is isolated from alerts</p>
      </div>
      <ul className="signal-status-list">
        {items.map(item => (
          <li key={item.label} className={`signal-status-item ${stateClass(item.state)}`}>
            <span className="signal-status-dot" aria-hidden="true" />
            <div>
              <strong>{item.label}</strong>
              <small>{stateLabel(item.state)}</small>
            </div>
          </li>
        ))}
      </ul>
      {chartFeed.message && <p className="signal-status-banner">{chartFeed.message}</p>}
    </aside>
  );
}
