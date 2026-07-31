import { useEffect, useState } from 'react';
import { adminApi } from '../services/api';
import { useAuth } from '../context/AuthContext';

function StatCard({ label, value, hint, tone = 'default' }) {
  return (
    <div className={`admin-stat-card tone-${tone}`}>
      <span className="admin-stat-label">{label}</span>
      <strong className="admin-stat-value">{value}</strong>
      {hint && <small className="admin-stat-hint">{hint}</small>}
    </div>
  );
}

export default function AdminDashboard() {
  const { user } = useAuth();
  const canManageScanner = Boolean(user?.isSuperAdmin || user?.canManageScannerConfig);
  const [stats, setStats] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    adminApi
      .getStats()
      .then(res => setStats(res.data))
      .catch(err => setError(err.response?.data?.message || 'Unable to load admin stats.'))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="loading-state">Loading admin overview…</div>;
  }

  if (error) {
    return <div className="feature-lock">{error}</div>;
  }

  const scanner = stats?.scanner || {};
  const config = scanner.config || {};
  const showConfig = canManageScanner && Boolean(config.autoScanEnabled != null);

  const signalTotal = stats?.signals?.total ?? 0;

  return (
    <div className="admin-dashboard">
      <div className="admin-stat-grid">
        <StatCard label="Total users" value={stats?.users?.total ?? 0} tone="accent" />
        <StatCard label="Active subscriptions" value={stats?.users?.activeSubscriptions ?? 0} tone="success" />
        <StatCard label="Signals today" value={stats?.signals?.today ?? 0} />
        <StatCard
          label="Open entry signals"
          value={stats?.signals?.openEntries ?? 0}
          tone="warning"
        />
        <StatCard label="Total signals" value={signalTotal} />
        <StatCard label="Completed payments" value={stats?.payments?.completed ?? 0} tone="success" />
        <StatCard label="Failed payments" value={stats?.payments?.failed ?? 0} tone="danger" />
        {showConfig && (
          <StatCard
            label="Auto-scan"
            value={config.autoScanEnabled ? 'On' : 'Off'}
            hint={`Every ${Math.round((config.autoScanIntervalMs || 0) / 1000)}s`}
          />
        )}
      </div>

      {signalTotal === 0 && (
        <div className="admin-panel">
          <div className="admin-panel-header">
            <h3>Signal source</h3>
            <span className="admin-pill status-inactive">TradingView webhooks</span>
          </div>
          <p className="admin-table-meta">
            Counters read the Mongo <code>Signal</code> collection. Production trades are ingested only from
            TradingView Pine webhooks — auto-scan does not create listable signals. After a successful alert,
            totals update here; historical zeros stay until the next webhook persists.
          </p>
        </div>
      )}

      {canManageScanner && (
        <div className="admin-panel">
          <div className="admin-panel-header">
            <h3>Scanner runtime</h3>
            <span className={`admin-pill ${config.autoScanEnabled ? 'status-active' : 'status-inactive'}`}>
              {config.autoScanEnabled ? 'Auto-scan on' : 'TradingView-only'}
            </span>
          </div>
          <dl className="admin-meta-grid">
            {showConfig && (
              <div className="admin-meta-item">
                <dt>Batch size</dt>
                <dd>{config.scanBatchSize ?? '—'} symbols / cycle</dd>
              </div>
            )}
            <div className="admin-meta-item">
              <dt>Strategies</dt>
              <dd>
                {(scanner.strategies || [])
                  .map(s => `${s.name}${s.enabled === false ? ' (off)' : ''}`)
                  .join(', ') || 'Day Trading, Scalping'}
              </dd>
            </div>
          </dl>
        </div>
      )}
    </div>
  );
}
