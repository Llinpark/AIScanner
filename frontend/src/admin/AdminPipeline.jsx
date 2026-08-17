import { useCallback, useEffect, useState } from 'react';
import { adminApi } from '../services/api';

function formatDate(value) {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleString();
  } catch {
    return '—';
  }
}

function formatMs(value) {
  if (value == null || Number.isNaN(Number(value))) return '—';
  const n = Number(value);
  if (n < 1000) return `${Math.round(n)} ms`;
  return `${(n / 1000).toFixed(1)} s`;
}

function eventStatusPillClass(status) {
  const s = String(status || '').toUpperCase();
  if (s === 'PASS') return 'status-active';
  if (s === 'SKIP' || s === 'N/A') return 'status-pending';
  return 'status-cancelled';
}

function eventStatusLabel(status) {
  const s = String(status || '').toUpperCase();
  if (s === 'SKIP') return 'SKIP / N/A';
  return status || '—';
}

function ToneDot({ tone }) {
  return <span className={`pipeline-tone pipeline-tone-${tone || 'yellow'}`} aria-hidden="true" />;
}

function Timeline({ stages }) {
  if (!stages?.length) {
    return <p className="admin-table-meta">No timeline data yet.</p>;
  }
  return (
    <ol className="pipeline-timeline">
      {stages.map(stage => (
        <li key={stage.id} className={`pipeline-timeline-item tone-${stage.tone || 'yellow'}`}>
          <ToneDot tone={stage.tone} />
          <div className="pipeline-timeline-body">
            <div className="pipeline-timeline-head">
              <strong>{stage.label}</strong>
              <span>{formatDate(stage.at)}</span>
            </div>
            {stage.durationMs != null && (
              <small className="admin-stat-hint">Δ {formatMs(stage.durationMs)}</small>
            )}
            {stage.note && <p className="pipeline-timeline-note">{stage.note}</p>}
          </div>
        </li>
      ))}
    </ol>
  );
}

export default function AdminPipeline() {
  const [status, setStatus] = useState(null);
  const [live, setLive] = useState(null);
  const [subscribers, setSubscribers] = useState([]);
  const [delivery, setDelivery] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setError('');
    try {
      const [statusRes, liveRes, subRes, deliveryRes] = await Promise.all([
        adminApi.getPipelineStatus(),
        adminApi.getLivePipeline({ limit: 100 }),
        adminApi.getPipelineSubscribers(),
        adminApi.getDeliveryStats()
      ]);
      setStatus(statusRes.data);
      setLive(liveRes.data);
      setSubscribers(subRes.data.subscribers || []);
      setDelivery(deliveryRes.data);
      if (!selectedId && subRes.data.subscribers?.[0]) {
        setSelectedId(subRes.data.subscribers[0].userId);
      }
    } catch (err) {
      setError(err.response?.data?.message || 'Unable to load pipeline diagnostics.');
    } finally {
      setLoading(false);
    }
  }, [selectedId]);

  useEffect(() => {
    load();
    const timer = setInterval(load, 15000);
    return () => clearInterval(timer);
  }, [load]);

  if (loading && !status) {
    return <div className="loading-state">Loading pipeline diagnostics…</div>;
  }

  if (error && !status) {
    return <div className="feature-lock">{error}</div>;
  }

  const selected = subscribers.find(s => s.userId === selectedId) || subscribers[0] || null;
  const healthy = status?.pipelineHealthy;
  const intakeState = status?.intakeState || 'NO_WEBHOOK_RECEIVED';
  const intakeTone =
    intakeState === 'TELEGRAM_SUCCESS' || intakeState === 'PIPELINE_ACTIVE'
      ? 'status-active'
      : intakeState === 'NO_WEBHOOK_RECEIVED'
        ? 'status-pending'
        : 'status-expired';

  return (
    <div className="admin-pipeline">
      <div className="admin-panel-header" style={{ marginBottom: 12 }}>
        <h3>Live pipeline</h3>
        <span className={`admin-pill ${healthy ? 'status-active' : 'status-pending'}`}>
          {healthy ? 'Healthy' : 'Check stages'}
        </span>
        <span className={`admin-pill ${intakeTone}`} title="Deterministic intake/delivery state">
          {intakeState}
        </span>
      </div>
      {intakeState === 'NO_WEBHOOK_RECEIVED' && (
        <p className="admin-table-meta" style={{ marginBottom: 12 }}>
          No TradingView webhook has reached the backend yet. An empty pipeline does not mean Telegram
          is broken — confirm the chart alert webhook URL and that Pine <code>alert()</code> is
          firing.
        </p>
      )}
      {intakeState === 'WEBHOOK_RECEIVED_AUTH_FAILED' && (
        <p className="admin-table-meta" style={{ marginBottom: 12 }}>
          A TradingView webhook arrived but authentication failed (licenseToken / username / userId).
        </p>
      )}
      {intakeState === 'WEBHOOK_PARSE_FAILED' && (
        <p className="admin-table-meta" style={{ marginBottom: 12 }}>
          A TradingView webhook arrived but the body was empty, not valid JSON, or a literal{' '}
          <code>{'{{…}}'}</code> placeholder. Fix the alert: Condition → Kaching indicator → Any{' '}
          <code>alert()</code> function call; Message → exactly <code>{'{{alert_message}}'}</code>{' '}
          (never <code>{'{{strategy.order.alert_message}}'}</code>). Check Fly logs for{' '}
          <code>[TV WEBHOOK CONFIG HINT]</code>.
        </p>
      )}
      {intakeState === 'WEBHOOK_SCHEMA_FAILED' && (
        <p className="admin-table-meta" style={{ marginBottom: 12 }}>
          Webhook authenticated but signal schema/levels validation failed.
        </p>
      )}
      {intakeState === 'SIGNAL_PERSIST_FAILED' && (
        <p className="admin-table-meta" style={{ marginBottom: 12 }}>
          Signal create/persist failed — Telegram was not attempted.
        </p>
      )}
      {intakeState === 'NO_ELIGIBLE_SUBSCRIBERS' && (
        <p className="admin-table-meta" style={{ marginBottom: 12 }}>
          Signal persisted, but no subscribers qualified for broadcast delivery.
        </p>
      )}
      {intakeState === 'TELEGRAM_DELIVERY_FAILED' && (
        <p className="admin-table-meta" style={{ marginBottom: 12 }}>
          Upstream pipeline succeeded far enough to attempt Telegram, but Telegram delivery failed.
          Check DeliveryTelegram reason / Bot API error.
        </p>
      )}
      {intakeState === 'TELEGRAM_SUCCESS' && (
        <p className="admin-table-meta" style={{ marginBottom: 12 }}>
          Latest recorded Telegram trade-alert delivery succeeded.
        </p>
      )}
      {intakeState === 'PIPELINE_ACTIVE' && (
        <p className="admin-table-meta" style={{ marginBottom: 12 }}>
          TradingView webhook activity has been received and the pipeline is processing beyond intake
          silence.
        </p>
      )}

      <div className="admin-stat-grid">
        <div className="admin-stat-card tone-accent">
          <span className="admin-stat-label">Signals today</span>
          <strong className="admin-stat-value">{delivery?.signalsToday ?? 0}</strong>
        </div>
        <div className="admin-stat-card">
          <span className="admin-stat-label">This week</span>
          <strong className="admin-stat-value">{delivery?.signalsWeek ?? 0}</strong>
        </div>
        <div className="admin-stat-card">
          <span className="admin-stat-label">This month</span>
          <strong className="admin-stat-value">{delivery?.signalsMonth ?? 0}</strong>
        </div>
        <div className="admin-stat-card tone-success">
          <span className="admin-stat-label">Delivered</span>
          <strong className="admin-stat-value">{delivery?.delivered ?? 0}</strong>
        </div>
        <div className="admin-stat-card tone-danger">
          <span className="admin-stat-label">Failed</span>
          <strong className="admin-stat-value">{delivery?.failed ?? 0}</strong>
        </div>
        <div className="admin-stat-card">
          <span className="admin-stat-label">Telegram success</span>
          <strong className="admin-stat-value">
            {delivery?.telegramSuccessPct != null ? `${delivery.telegramSuccessPct}%` : '—'}
          </strong>
        </div>
        <div className="admin-stat-card">
          <span className="admin-stat-label">MT5 success</span>
          <strong className="admin-stat-value">
            {delivery?.mt5SuccessPct != null ? `${delivery.mt5SuccessPct}%` : '—'}
          </strong>
          <small className="admin-stat-hint">— = no MT5 attempts (Telegram-only is OK)</small>
        </div>
        <div className="admin-stat-card">
          <span className="admin-stat-label">Webhook success</span>
          <strong className="admin-stat-value">
            {delivery?.webhookSuccessPct != null ? `${delivery.webhookSuccessPct}%` : '—'}
          </strong>
        </div>
        <div className="admin-stat-card tone-warning">
          <span className="admin-stat-label">Avg pipeline</span>
          <strong className="admin-stat-value">{formatMs(delivery?.avgPipelineLatencyMs)}</strong>
          <small className="admin-stat-hint">
            Fast {formatMs(delivery?.fastestPipelineLatencyMs)} · Slow{' '}
            {formatMs(delivery?.slowestPipelineLatencyMs)}
          </small>
        </div>
        <div className="admin-stat-card">
          <span className="admin-stat-label">Webhook → Mongo</span>
          <strong className="admin-stat-value">{formatMs(delivery?.avgWebhookToMongoMs)}</strong>
        </div>
        <div className="admin-stat-card">
          <span className="admin-stat-label">Mongo → Telegram</span>
          <strong className="admin-stat-value">{formatMs(delivery?.avgMongoToTelegramMs)}</strong>
        </div>
        <div className="admin-stat-card">
          <span className="admin-stat-label">Subscribers never webhooked</span>
          <strong className="admin-stat-value">{status?.waitingSubscribers ?? 0}</strong>
          <small className="admin-stat-hint">
            Active {status?.activeSubscribers ?? subscribers.length} · not a pipeline stall
          </small>
        </div>
      </div>

      <div className="admin-panel">
        <div className="admin-panel-header">
          <h3>Global stage snapshot</h3>
          <button type="button" className="admin-secondary-btn" onClick={load}>
            Refresh
          </button>
        </div>
        <dl className="admin-meta-grid">
          <div className="admin-meta-item">
            <dt>Last Webhook Received</dt>
            <dd>{formatDate(status?.lastWebhook?.at || status?.lastWebhookReceived?.at)}</dd>
          </div>
          <div className="admin-meta-item">
            <dt>Last Auth PASS/FAIL</dt>
            <dd>
              {status?.lastFailureStage === 'Auth'
                ? `FAIL — ${status.lastFailureReason || 'unauthorized'}`
                : status?.lastAuthPassed
                  ? `PASS — ${formatDate(status.lastAuthPassed.at)}`
                  : '—'}
            </dd>
          </div>
          <div className="admin-meta-item">
            <dt>Last Validation PASS/FAIL</dt>
            <dd>
              {status?.lastFailureStage === 'Validation'
                ? `FAIL — ${status.lastFailureReason || 'validation_failed'}`
                : status?.lastValidation
                  ? `PASS — ${formatDate(status.lastValidation.at)}`
                  : '—'}
            </dd>
          </div>
          <div className="admin-meta-item">
            <dt>Last Mongo Save</dt>
            <dd>{formatDate(status?.lastMongoSave?.at)}</dd>
          </div>
          <div className="admin-meta-item">
            <dt>Last Telegram Delivery</dt>
            <dd>{formatDate(status?.lastTelegram?.at || status?.lastTelegramDelivery?.at)}</dd>
          </div>
          <div className="admin-meta-item">
            <dt>Last MT5 Delivery</dt>
            <dd>{formatDate(status?.lastMT5?.at || status?.lastMT5Delivery?.at)}</dd>
          </div>
          <div className="admin-meta-item">
            <dt>Last Failure Stage</dt>
            <dd>{status?.lastFailureStage || '—'}</dd>
          </div>
          <div className="admin-meta-item">
            <dt>Last Failure Reason</dt>
            <dd>{status?.lastFailureReason || '—'}</dd>
          </div>
          <div className="admin-meta-item">
            <dt>Last published</dt>
            <dd>{formatDate(status?.lastPublishedSignal?.at)}</dd>
          </div>
          <div className="admin-meta-item">
            <dt>Last Socket</dt>
            <dd>{formatDate(status?.lastSocket?.at)}</dd>
          </div>
          <div className="admin-meta-item">
            <dt>Current stage</dt>
            <dd>{status?.currentPipelineStage || '—'}</dd>
          </div>
          <div className="admin-meta-item">
            <dt>Webhook age</dt>
            <dd>
              {status?.webhookAge?.message || 'OK'}
              {status?.webhookAge?.warning ? ' (warning)' : ''}
            </dd>
          </div>
        </dl>
        <Timeline stages={status?.timeline || []} />
      </div>

      <div className="admin-panel">
        <div className="admin-panel-header">
          <h3>TradingView alert status</h3>
          <span className="admin-pill status-inactive">{subscribers.length} subscribers</span>
        </div>
        {error && <p className="pipeline-timeline-note">{error}</p>}
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Subscriber</th>
                <th>TV username</th>
                <th>Pine generated</th>
                <th>Last webhook</th>
                <th>Signal</th>
                <th>Telegram / MT5 / Socket</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {subscribers.length === 0 && (
                <tr>
                  <td colSpan={7}>No active subscribers.</td>
                </tr>
              )}
              {subscribers.map(row => (
                <tr
                  key={row.userId}
                  className={selected?.userId === row.userId ? 'is-selected' : undefined}
                  onClick={() => setSelectedId(row.userId)}
                  style={{ cursor: 'pointer' }}
                >
                  <td>
                    <div>{row.displayName || row.email}</div>
                    <small className="admin-table-meta">{row.email}</small>
                  </td>
                  <td>
                    <code>{row.tradingviewUsername || '—'}</code>
                  </td>
                  <td>
                    {formatDate(row.lastPineGeneratedAt)}
                    {row.lastPineStrategy && (
                      <div>
                        <small className="admin-table-meta">{row.lastPineStrategy}</small>
                      </div>
                    )}
                  </td>
                  <td>{formatDate(row.lastWebhookAt)}</td>
                  <td>{row.lastSignalLabel}</td>
                  <td>
                    <small className="admin-table-meta">
                      TG {formatDate(row.lastTelegramAt)}
                      <br />
                      MT5 {formatDate(row.lastMT5At)}
                      <br />
                      Sock {formatDate(row.lastSocketAt)}
                    </small>
                  </td>
                  <td>
                    {row.alertEngineReminder?.remind && (
                      <div className="pipeline-warn">{row.alertEngineReminder.message}</div>
                    )}
                    {row.webhookAge?.warning && (
                      <div className="pipeline-warn">{row.webhookAge.message}</div>
                    )}
                    {row.waitingForFirstWebhook && !row.alertEngineReminder?.remind && (
                      <span className="admin-pill status-pending">Waiting for first webhook</span>
                    )}
                    {!row.waitingForFirstWebhook &&
                      !row.webhookAge?.warning &&
                      !row.alertEngineReminder?.remind && (
                        <span className="admin-pill status-active">OK</span>
                      )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {selected && (
          <div className="pipeline-subscriber-detail">
            <h4>
              Timeline — {selected.displayName || selected.email}
              {selected.tradingviewUsername ? ` · @${selected.tradingviewUsername}` : ''}
            </h4>
            <p className="admin-table-meta">{selected.alertCreationReminder}</p>
            {selected.alertEngineReminder?.remind && (
              <p className="pipeline-warn">{selected.alertEngineReminder.message}</p>
            )}
            <Timeline stages={selected.timeline || []} />
          </div>
        )}
      </div>

      <div className="admin-panel">
        <div className="admin-panel-header">
          <h3>Live event ring (last 100)</h3>
          <span className="admin-pill status-inactive">{live?.count ?? 0} events</span>
        </div>
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Stage</th>
                <th>Status</th>
                <th>Symbol</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {(live?.events || []).length === 0 && (
                <tr>
                  <td colSpan={5}>No events yet — waiting for TradingView webhooks.</td>
                </tr>
              )}
              {(live?.events || []).map((ev, idx) => (
                <tr key={`${ev.at}-${ev.type}-${idx}`}>
                  <td>{formatDate(ev.at)}</td>
                  <td>{ev.type}</td>
                  <td>
                    <span className={`admin-pill ${eventStatusPillClass(ev.status)}`}>
                      {eventStatusLabel(ev.status)}
                    </span>
                  </td>
                  <td>{ev.symbol || '—'}</td>
                  <td>
                    <small className="admin-table-meta">{ev.reason || '—'}</small>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
