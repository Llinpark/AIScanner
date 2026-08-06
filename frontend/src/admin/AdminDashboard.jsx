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

function formatMs(value) {
  if (value == null || Number.isNaN(Number(value))) return '—';
  const n = Number(value);
  if (n < 1000) return `${Math.round(n)} ms`;
  return `${(n / 1000).toFixed(1)} s`;
}

export default function AdminDashboard() {
  const { user } = useAuth();
  const canManageScanner = Boolean(user?.isSuperAdmin || user?.canManageScannerConfig);
  const [stats, setStats] = useState(null);
  const [pipeline, setPipeline] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([adminApi.getStats(), adminApi.getPipelineStatus().catch(() => null)])
      .then(([statsRes, pipelineRes]) => {
        setStats(statsRes.data);
        if (pipelineRes?.data) setPipeline(pipelineRes.data);
      })
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
  const delivery = pipeline?.deliveryStats || {};

  return (
    <div className="admin-dashboard">
      <div className="admin-stat-grid">
        <StatCard label="Total users" value={stats?.users?.total ?? 0} tone="accent" />
        <StatCard label="Active subscriptions" value={stats?.users?.activeSubscriptions ?? 0} tone="success" />
        <StatCard label="Signals today" value={delivery.signalsToday ?? stats?.signals?.today ?? 0} />
        <StatCard label="Signals week" value={delivery.signalsWeek ?? '—'} />
        <StatCard label="Signals month" value={delivery.signalsMonth ?? '—'} />
        <StatCard
          label="Open entry signals"
          value={stats?.signals?.openEntries ?? 0}
          tone="warning"
        />
        <StatCard label="Delivered" value={delivery.delivered ?? 0} tone="success" />
        <StatCard label="Failed deliveries" value={delivery.failed ?? 0} tone="danger" />
        <StatCard
          label="Telegram success"
          value={delivery.telegramSuccessPct != null ? `${delivery.telegramSuccessPct}%` : '—'}
        />
        <StatCard
          label="MT5 success"
          value={delivery.mt5SuccessPct != null ? `${delivery.mt5SuccessPct}%` : '—'}
        />
        <StatCard
          label="Avg pipeline latency"
          value={formatMs(delivery.avgPipelineLatencyMs ?? pipeline?.averagePipelineLatency)}
          hint={`WH→Mongo ${formatMs(delivery.avgWebhookToMongoMs)} · Mongo→TG ${formatMs(delivery.avgMongoToTelegramMs)}`}
        />
        <StatCard
          label="Waiting for first webhook"
          value={pipeline?.waitingSubscribers ?? 0}
          tone="warning"
          hint={`${pipeline?.activeSubscribers ?? 0} active subscribers`}
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

      {(signalTotal === 0 || pipeline?.waitingSubscribers > 0) && (
        <div className="admin-panel">
          <div className="admin-panel-header">
            <h3>Signal source</h3>
            <span className="admin-pill status-inactive">TradingView webhooks</span>
          </div>
          <p className="admin-table-meta">
            Counters read the Mongo <code>Signal</code> collection. Production trades are ingested only from
            TradingView Pine webhooks — auto-scan does not create listable signals. If subscribers show
            &quot;Waiting for first TradingView webhook&quot;, the Alert Engine likely never POSTed — open the
            Pipeline tab to diagnose Pine generation vs webhook age.
          </p>
          {pipeline?.webhookAge?.warning && (
            <p className="pipeline-warn">{pipeline.webhookAge.message}</p>
          )}
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
            <div className="admin-meta-item">
              <dt>Pipeline health</dt>
              <dd>{pipeline?.pipelineHealthy ? 'Healthy' : 'Check Pipeline tab'}</dd>
            </div>
          </dl>
        </div>
      )}
    </div>
  );
}
