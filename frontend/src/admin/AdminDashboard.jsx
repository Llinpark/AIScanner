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
  const showConfig = canManageScanner && Boolean(config.premiumThreshold != null || config.autoScanEnabled != null);

  return (
    <div className="admin-dashboard">
      <div className="admin-stat-grid">
        <StatCard label="Total users" value={stats?.users?.total ?? 0} tone="accent" />
        <StatCard label="Active subscriptions" value={stats?.users?.activeSubscriptions ?? 0} tone="success" />
        <StatCard label="Signals today" value={stats?.signals?.today ?? 0} />
        <StatCard
          label="Open entry signals"
          value={stats?.signals?.openEntries ?? 0}
          hint="Global count in MongoDB"
          tone="warning"
        />
        <StatCard label="Total signals" value={stats?.signals?.total ?? 0} />
        <StatCard label="Completed payments" value={stats?.payments?.completed ?? 0} tone="success" />
        <StatCard label="Failed payments" value={stats?.payments?.failed ?? 0} tone="danger" />
        {showConfig && (
          <>
            <StatCard
              label="Premium threshold"
              value={`${config.premiumThreshold ?? '—'}%`}
              hint="Live scanner config"
              tone="accent"
            />
            <StatCard
              label="Auto-scan"
              value={config.autoScanEnabled ? 'On' : 'Off'}
              hint={`Every ${Math.round((config.autoScanIntervalMs || 0) / 1000)}s`}
            />
          </>
        )}
        <StatCard
          label="Database"
          value={stats?.dbConnected ? 'Connected' : 'Offline'}
          tone={stats?.dbConnected ? 'success' : 'danger'}
        />
      </div>

      <div className="admin-panel">
        <div className="admin-panel-header">
          <h3>Scanner runtime</h3>
          <span className={`admin-pill ${scanner.pipeline?.enabled ? 'status-active' : 'status-inactive'}`}>
            {scanner.pipeline?.enabled ? 'Pipeline active' : 'Pipeline off'}
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
            <dt>HTF timeframe</dt>
            <dd>{scanner.pipeline?.htfTimeframe ?? '—'}</dd>
          </div>
          <div className="admin-meta-item">
            <dt>Symbol buffers</dt>
            <dd>{(scanner.buffers || []).filter(b => b.candles > 0).length} loaded</dd>
          </div>
          <div className="admin-meta-item">
            <dt>Admin emails</dt>
            <dd>{stats?.adminEmailsConfigured ?? 0} configured</dd>
          </div>
        </dl>
      </div>
    </div>
  );
}
