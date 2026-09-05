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

function formatPct(value) {
  return value != null ? `${value}%` : '—';
}

function formatChannelPct(pct, attempted) {
  if (pct == null || !Number(attempted)) return '—';
  return `${pct}%`;
}

function channelCounts(ch) {
  const op = ch?.operational || ch || {};
  const w30 = ch?.window30d || null;
  return {
    attempted: op.attempted ?? (op.succeeded || 0) + (op.failed || 0),
    succeeded: op.succeeded ?? 0,
    failed: op.failed ?? 0,
    skipped: op.skipped ?? ch?.skipped ?? 0,
    notEligible: op.notEligible ?? ch?.notEligible ?? 0,
    pending: op.pending ?? ch?.pending ?? 0,
    windowAttempted: w30?.attempted ?? null,
    windowSucceeded: w30?.succeeded ?? null,
    windowFailed: w30?.failed ?? null
  };
}

function channelHint(name, ch, liveEligible) {
  const c = channelCounts(ch);
  const reason = ch?.displayReason;
  const mt5Unlinked =
    name === 'mt5' && (reason === 'no_mt5_subscribers_linked' || Number(liveEligible) === 0);
  if (mt5Unlinked) return 'No MT5 subscribers linked';
  if (!c.attempted) {
    if (reason === 'no_operational_provider_attempts') {
      return `0 provider attempts (24h) · 30d historical ${c.windowSucceeded ?? 0} ok / ${c.windowFailed ?? 0} failed — not operational health`;
    }
    return '0 provider attempts (24h)';
  }
  return null;
}

function ChannelBreakdown({ name, ch, pct, liveEligible }) {
  const c = channelCounts(ch);
  const hint = channelHint(name, ch, liveEligible);
  return (
    <>
      <strong className="admin-stat-value">{formatChannelPct(pct, c.attempted)}</strong>
      <small className="admin-stat-breakdown">
        <span>24h attempted {c.attempted}</span>
        <span>Successful {c.succeeded}</span>
        <span>Failed {c.failed}</span>
        <span>Skipped {c.skipped}</span>
        <span>Not eligible {c.notEligible}</span>
        <span>Pending {c.pending}</span>
        {c.windowAttempted != null && (
          <span>
            30d attempted {c.windowAttempted} · ok {c.windowSucceeded ?? 0} · failed {c.windowFailed ?? 0}
          </span>
        )}
      </small>
      {hint && <small className="admin-stat-hint">{hint}</small>}
    </>
  );
}

function healthTone(level) {
  const l = String(level || '').toUpperCase();
  if (l === 'HEALTHY') return 'status-active';
  if (l === 'CRITICAL') return 'status-expired';
  return 'status-pending';
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
  const [corrQuery, setCorrQuery] = useState({ requestId: '', signalUuid: '', symbol: '' });
  const [corrResult, setCorrResult] = useState(null);
  const [corrLoading, setCorrLoading] = useState(false);

  const loadStatus = useCallback(async () => {
    const statusRes = await adminApi.getPipelineStatus();
    const statusData = statusRes.data;
    setStatus(statusData);
    const nextSubs = statusData?.subscribers || statusData?.subscribersPreview || [];
    setSubscribers(nextSubs);
    setDelivery(statusData?.delivery || statusData?.deliveryStats || null);
    setSelectedId(prev => prev || nextSubs[0]?.userId || prev);
    return statusData;
  }, []);

  const loadLive = useCallback(async () => {
    const liveRes = await adminApi.getLivePipeline({ limit: 100 });
    setLive(liveRes.data);
    return liveRes.data;
  }, []);

  const load = useCallback(async () => {
    setError('');
    try {
      const [statusRes, liveRes] = await Promise.allSettled([loadStatus(), loadLive()]);
      const statusData = statusRes.status === 'fulfilled' ? statusRes.value : null;
      if (statusRes.status === 'rejected' && liveRes.status === 'rejected') {
        const err = statusRes.reason;
        setError(err.response?.data?.message || 'Unable to load pipeline diagnostics.');
      } else if (statusData?.status === 'degraded' || statusData?.redis?.status === 'unavailable') {
        setError('');
      }
    } catch (err) {
      setError(err.response?.data?.message || 'Unable to load pipeline diagnostics.');
    } finally {
      setLoading(false);
    }
  }, [loadStatus, loadLive]);

  useEffect(() => {
    load();
    const liveTimer = setInterval(() => {
      loadLive().catch(() => {});
    }, 15000);
    const statusTimer = setInterval(() => {
      loadStatus().catch(() => {});
    }, 60000);
    return () => {
      clearInterval(liveTimer);
      clearInterval(statusTimer);
    };
  }, [load, loadLive, loadStatus]);

  if (loading && !status) {
    return <div className="loading-state">Loading pipeline diagnostics…</div>;
  }

  if (error && !status) {
    return <div className="feature-lock">{error}</div>;
  }

  const selected = subscribers.find(s => s.userId === selectedId) || subscribers[0] || null;
  const redisDegraded =
    status?.status === 'degraded' || status?.redis?.status === 'unavailable';
  const healthLevel = delivery?.health?.level;
  const healthy = healthLevel
    ? healthLevel === 'HEALTHY'
    : Boolean(status?.pipelineHealthy) && !redisDegraded;
  const intakeState = status?.intakeState || 'NO_WEBHOOK_RECEIVED';
  const intake = delivery?.intake || delivery?.webhook || {};
  const channels = delivery?.channels || {};
  const issues = delivery?.issues || {};
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
        <span
          className={`admin-pill ${healthTone(healthLevel || (healthy ? 'HEALTHY' : redisDegraded ? 'CRITICAL' : 'DEGRADED'))}`}
          title={(delivery?.health?.reasons || []).join(', ') || undefined}
        >
          {healthLevel || (healthy ? 'HEALTHY' : redisDegraded ? 'CRITICAL' : 'DEGRADED')}
        </span>
        <span className={`admin-pill ${intakeTone}`} title="Deterministic intake/delivery state">
          {intakeState}
        </span>
      </div>
      {(status?.status === 'degraded' || status?.redis?.status === 'unavailable') && (
        <p className="admin-table-meta" style={{ marginBottom: 12 }}>
          Pipeline diagnostics are degraded
          {status?.redis?.errorCode ? ` (${status.redis.errorCode})` : ''}. Webhook ingest stays
          fail-closed until Redis is connected; this page no longer waits on Redis forever.
        </p>
      )}
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

      {delivery?.windowNote && (
        <p className="admin-table-meta" style={{ marginBottom: 12 }}>
          {delivery.windowNote}
        </p>
      )}
      {Array.isArray(delivery?.health?.reasons) && delivery.health.reasons.length > 0 && (
        <p className="admin-table-meta" style={{ marginBottom: 12 }}>
          Health reasons: {delivery.health.reasons.join(' · ')}
          {delivery.health.window ? ` (${delivery.health.window})` : ''}
        </p>
      )}

      <div className="pipeline-card-section">
        <h4>INTAKE</h4>
        <div className="admin-stat-grid">
          <div className="admin-stat-card tone-accent">
            <span className="admin-stat-label">Received</span>
            <strong className="admin-stat-value">{intake.received ?? 0}</strong>
            <small className="admin-stat-hint">Durable webhook_intake (not last-100 ring)</small>
          </div>
          <div className="admin-stat-card">
            <span className="admin-stat-label">HTTP 2xx / accepted</span>
            <strong className="admin-stat-value">
              {intake.http2xx ?? 0} / {intake.accepted ?? 0}
            </strong>
          </div>
          <div className="admin-stat-card">
            <span className="admin-stat-label">Persisted / fan-out</span>
            <strong className="admin-stat-value">
              {intake.persisted ?? 0} / {intake.fanoutScheduled ?? 0}
            </strong>
            <small className="admin-stat-hint">
              skipped no fan-out {intake.skippedNoFanout ?? 0} · fan-out complete ≠ every channel delivered
            </small>
          </div>
          <div className="admin-stat-card tone-danger">
            <span className="admin-stat-label">Rejected</span>
            <strong className="admin-stat-value">{intake.rejected ?? 0}</strong>
            <small className="admin-stat-hint">
              {Object.entries(intake.byCategory || {})
                .map(([k, v]) => `${k} ${v}`)
                .join(' · ') || '—'}
            </small>
          </div>
          <div className="admin-stat-card">
            <span className="admin-stat-label">Webhook acceptance</span>
            <strong className="admin-stat-value">{formatPct(delivery?.webhookSuccessPct)}</strong>
            <small className="admin-stat-hint">
              accepted / received · not subscriber delivery · intake TTL ~{delivery?.webhookIntakeTtlDays ?? 7}d
            </small>
          </div>
        </div>
      </div>

      <div className="pipeline-card-section">
        <h4>SIGNALS</h4>
        <div className="admin-stat-grid">
          <div className="admin-stat-card tone-accent">
            <span className="admin-stat-label">ENTRY today</span>
            <strong className="admin-stat-value">{delivery?.signalsToday ?? 0}</strong>
          </div>
          <div className="admin-stat-card">
            <span className="admin-stat-label">ENTRY week</span>
            <strong className="admin-stat-value">{delivery?.signalsWeek ?? 0}</strong>
          </div>
          <div className="admin-stat-card">
            <span className="admin-stat-label">ENTRY month</span>
            <strong className="admin-stat-value">{delivery?.signalsEntryMonth ?? delivery?.signalsMonth ?? 0}</strong>
          </div>
          <div className="admin-stat-card">
            <span className="admin-stat-label">Lifecycle month</span>
            <strong className="admin-stat-value">{delivery?.signalsLifecycleMonth ?? 0}</strong>
            <small className="admin-stat-hint">TP/SL/expired — not ENTRY</small>
          </div>
        </div>
      </div>

      <div className="pipeline-card-section">
        <h4>SIGNAL ROLLUP (30d · not provider delivery)</h4>
        <div className="admin-stat-grid">
          <div className="admin-stat-card tone-success">
            <span className="admin-stat-label">Signals delivered</span>
            <strong className="admin-stat-value">{delivery?.delivered ?? 0}</strong>
            <small className="admin-stat-hint">Signal.deliveryStatus rollup · not Telegram/MT5 send</small>
          </div>
          <div className="admin-stat-card">
            <span className="admin-stat-label">Partial</span>
            <strong className="admin-stat-value">{delivery?.partial ?? 0}</strong>
          </div>
          <div className="admin-stat-card tone-danger">
            <span className="admin-stat-label">Signals failed</span>
            <strong className="admin-stat-value">{delivery?.failedSignals ?? delivery?.failed ?? 0}</strong>
            <small className="admin-stat-hint">
              ENTRY rollup only · jobs failed 24h {delivery?.providerFailed24h ?? 0} · 30d{' '}
              {delivery?.providerFailed30d ?? 0}
            </small>
          </div>
          <div className="admin-stat-card">
            <span className="admin-stat-label">Skipped / pending</span>
            <strong className="admin-stat-value">
              {delivery?.skipped ?? 0} / {delivery?.pending ?? 0}
            </strong>
          </div>
          <div className="admin-stat-card">
            <span className="admin-stat-label">LEGACY / UNKNOWN</span>
            <strong className="admin-stat-value">{delivery?.legacyUnknown ?? 0}</strong>
            <small className="admin-stat-hint">Historical Signals without per-recipient jobs — not invented success</small>
          </div>
        </div>
      </div>

      <div className="pipeline-card-section">
        <h4>CHANNELS (success % = 24h provider attempts only)</h4>
        <p className="admin-table-meta">
          Email and Telegram are independent per subscriber and lifecycle event. A retry, outage, or
          failed_terminal on one channel must never mark the other delivered. fanout_complete means
          fan-out work finished — not that every channel delivered.
        </p>
        <div className="admin-stat-grid">
          <div className="admin-stat-card">
            <span className="admin-stat-label">Telegram</span>
            <ChannelBreakdown
              name="telegram"
              ch={channels.telegram || delivery?.telegram}
              pct={delivery?.telegramSuccessPct ?? channels.telegram?.successPct}
              liveEligible={delivery?.liveEligible?.telegram}
            />
          </div>
          <div className="admin-stat-card">
            <span className="admin-stat-label">Email</span>
            <ChannelBreakdown
              name="email"
              ch={channels.email || delivery?.email}
              pct={channels.email?.successPct ?? delivery?.emailSuccessPct}
              liveEligible={delivery?.liveEligible?.email}
            />
          </div>
          <div className="admin-stat-card">
            <span className="admin-stat-label">MT5</span>
            <ChannelBreakdown
              name="mt5"
              ch={channels.mt5 || delivery?.mt5}
              pct={delivery?.mt5SuccessPct ?? channels.mt5?.successPct}
              liveEligible={delivery?.liveEligible?.mt5}
            />
          </div>
          <div className="admin-stat-card">
            <span className="admin-stat-label">Socket</span>
            <ChannelBreakdown
              name="socket"
              ch={channels.socket || delivery?.socket}
              pct={channels.socket?.successPct}
              liveEligible={null}
            />
          </div>
        </div>
      </div>

      <div className="pipeline-card-section">
        <h4>PIPELINE ISSUES</h4>
        <div className="admin-stat-grid">
          <div className="admin-stat-card">
            <span className="admin-stat-label">missing_channel_payload</span>
            <strong className="admin-stat-value">{issues.missing_channel_payload ?? 0}</strong>
          </div>
          <div className="admin-stat-card">
            <span className="admin-stat-label">delivery_sequence_wait</span>
            <strong className="admin-stat-value">{issues.delivery_sequence_wait ?? 0}</strong>
            <small className="admin-stat-hint">
              unhealthy {issues.sequence_wait_unhealthy ?? 0} · expired{' '}
              {issues.sequence_wait_expired ?? 0} · retry_scheduled {issues.retry_scheduled ?? issues.retrying ?? 0}
            </small>
          </div>
          <div className="admin-stat-card">
            <span className="admin-stat-label">stale_trade_before_delivery</span>
            <strong className="admin-stat-value">{issues.stale_trade_before_delivery ?? 0}</strong>
          </div>
          <div className="admin-stat-card">
            <span className="admin-stat-label">redis_unavailable / unrecoverable</span>
            <strong className="admin-stat-value">
              {issues.redis_unavailable ?? 0} / {issues.delivery_context_unrecoverable ?? 0}
            </strong>
            <small className="admin-stat-hint">
              retrying {issues.retrying ?? 0} · failed_terminal {issues.failedTerminal ?? 0}
            </small>
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
      </div>

      <div className="admin-panel" style={{ marginBottom: 16 }}>
        <div className="admin-panel-header">
          <h3>Signal correlation</h3>
        </div>
        <p className="admin-table-meta">
          Diagnostic search by requestId or signalUuid. HTTP 2xx is not delivery. No secrets.
        </p>
        <form
          className="admin-inline-form"
          onSubmit={async e => {
            e.preventDefault();
            setCorrLoading(true);
            try {
              const res = await adminApi.getSignalCorrelation({
                requestId: corrQuery.requestId || undefined,
                signalUuid: corrQuery.signalUuid || undefined,
                symbol: corrQuery.symbol || undefined
              });
              setCorrResult(res.data);
            } catch (err) {
              setCorrResult({ ok: false, error: err.message, timeline: [], jobs: [] });
            } finally {
              setCorrLoading(false);
            }
          }}
        >
          <input
            placeholder="requestId"
            value={corrQuery.requestId}
            onChange={e => setCorrQuery(q => ({ ...q, requestId: e.target.value }))}
          />
          <input
            placeholder="signalUuid"
            value={corrQuery.signalUuid}
            onChange={e => setCorrQuery(q => ({ ...q, signalUuid: e.target.value }))}
          />
          <input
            placeholder="symbol (GBPJPY or GBP/JPY)"
            value={corrQuery.symbol}
            onChange={e => setCorrQuery(q => ({ ...q, symbol: e.target.value }))}
          />
          <button type="submit" className="admin-secondary-btn" disabled={corrLoading}>
            {corrLoading ? 'Searching…' : 'Search'}
          </button>
        </form>
        {corrResult?.firstFailingBoundary && (
          <p className="admin-table-meta" style={{ marginTop: 8 }}>
            First failing boundary: {corrResult.firstFailingBoundary.stage || corrResult.firstFailingBoundary.tag || 'n/a'}{' '}
            {corrResult.firstFailingBoundary.state || corrResult.firstFailingBoundary.outcomeStatus || ''}{' '}
            {corrResult.firstFailingBoundary.reason || ''}
          </p>
        )}
        {Array.isArray(corrResult?.timeline) && corrResult.timeline.length > 0 && (
          <ul className="admin-table-meta">
            {corrResult.timeline.slice(0, 20).map((ev, idx) => (
              <li key={`${ev.stage}-${idx}`}>
                {ev.stage} {ev.channel || ''} {ev.outcomeStatus || ev.state || ev.category || ''}
                {ev.reason ? ` (${ev.reason})` : ''}
              </li>
            ))}
          </ul>
        )}
        {Array.isArray(corrResult?.deliveryJobs) && corrResult.deliveryJobs.length > 0 && (
          <ul className="admin-table-meta">
            {corrResult.deliveryJobs.slice(0, 12).map(job => (
              <li key={job.jobId}>
                {job.channel} {job.eventType} {job.outcomeStatus || job.state}
                {job.outcomeReason ? ` (${job.outcomeReason})` : ''}
              </li>
            ))}
          </ul>
        )}
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
              {(() => {
                const failed = status?.lastAuthFailed;
                const passed = status?.lastAuthPassed;
                const failIsLatest =
                  Boolean(failed?.at) &&
                  (!passed?.at || new Date(failed.at).getTime() >= new Date(passed.at).getTime());
                const latestLabel = (() => {
                  if (failIsLatest || status?.lastFailureStage === 'Auth') {
                    const reason =
                      (failIsLatest ? failed?.reason : null) ||
                      status?.lastFailureReason ||
                      'unauthorized';
                    return `FAIL — ${reason}`;
                  }
                  if (passed) return `PASS — ${formatDate(passed.at)}`;
                  return '—';
                })();
                return (
                  <>
                    <div>{latestLabel}</div>
                    {status?.lastAuthDiagnostics && (
                      <div className="admin-muted" style={{ marginTop: 4, fontSize: '0.85em' }}>
                        {[
                          status.lastAuthDiagnostics.requestId
                            ? `requestId=${status.lastAuthDiagnostics.requestId}`
                            : null,
                          status.lastAuthDiagnostics.tokenVersion
                            ? `tokenVersion=${status.lastAuthDiagnostics.tokenVersion}`
                            : null,
                          status.lastAuthDiagnostics.tokenEnvironment
                            ? `tokenEnv=${status.lastAuthDiagnostics.tokenEnvironment}`
                            : null,
                          status.lastAuthDiagnostics.scriptGenerationId
                            ? `scriptGenerationId=${status.lastAuthDiagnostics.scriptGenerationId}`
                            : null,
                          status.lastAuthDiagnostics.symbol
                            ? `symbol=${status.lastAuthDiagnostics.symbol}`
                            : null,
                          status.lastAuthDiagnostics.alertType
                            ? `alertType=${status.lastAuthDiagnostics.alertType}`
                            : null
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </div>
                    )}
                    {failed && !failIsLatest && (
                      <div className="admin-muted" style={{ marginTop: 6, fontSize: '0.85em' }}>
                        Last Auth FAIL remains visible: {failed.reason || 'unauthorized'} —{' '}
                        {formatDate(failed.at)}
                        {failed.requestId ? ` · requestId=${failed.requestId}` : ''}
                        {failed.symbol ? ` · ${failed.symbol}` : ''}
                        {failed.alertType ? ` ${failed.alertType}` : ''}
                      </div>
                    )}
                  </>
                );
              })()}
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
            <dd>
              {formatDate(status?.lastMongoSave?.at)}
              {status?.lastMongoSaveDurable === false ||
              status?.lastMongoSaveIsInMemoryFallback ||
              status?.lastMongoSaveIsSelfTest ? (
                <div className="admin-muted" style={{ marginTop: 4, fontSize: '0.85em' }}>
                  {status?.lastMongoSaveNote ||
                    (status?.lastMongoSaveIsSelfTest
                      ? 'Self-test / non-production telemetry — not a durable production Signal'
                      : 'In-memory fallback — not a durable Mongo Signal')}
                </div>
              ) : null}
            </dd>
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
