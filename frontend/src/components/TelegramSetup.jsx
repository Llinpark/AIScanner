import { useCallback, useEffect, useState } from 'react';
import { mt5Api, telegramApi } from '../services/api';

const RISK_PRESETS = [0.5, 1, 2, 3, 5];
const RISK_MIN = 0.1;
/** Safety ceiling only — not a product recommendation. Must match backend RISK_PERCENT_MAX. */
const RISK_MAX = 100;

const TG_MANUAL = 'manual_confirmation';
const TG_ALERTS = 'alerts_only';

function normalizeRiskPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.min(RISK_MAX, Math.max(RISK_MIN, Number(n.toFixed(2))));
}

function normalizeTelegramMode(raw) {
  const v = String(raw || '').toLowerCase();
  if (v === TG_ALERTS || v === 'alerts' || v === 'telegram_alerts') return TG_ALERTS;
  return TG_MANUAL;
}

function formatCountdown(expiresAt) {
  if (!expiresAt) return '';
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return 'Expired';
  const totalSec = Math.ceil(ms / 1000);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `Expires in ${mins}:${String(secs).padStart(2, '0')}`;
}

function formatDeviceActive(iso) {
  if (!iso) return 'Never';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return '—';
  }
}

export default function TelegramSetup({ tierLimits, onNavigatePricing }) {
  const [status, setStatus] = useState(null);
  const [mt5Status, setMt5Status] = useState(null);
  const [linkInfo, setLinkInfo] = useState(null);
  const [mt5PairInfo, setMt5PairInfo] = useState(null);
  const [pairCountdown, setPairCountdown] = useState('');
  const [riskPercent, setRiskPercent] = useState(1);
  const [fixedLotSize, setFixedLotSize] = useState(0.01);
  const [symbolSuffix, setSymbolSuffix] = useState('');
  const [executionMode, setExecutionMode] = useState('manual');
  const [telegramMode, setTelegramMode] = useState(TG_MANUAL);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saveNotice, setSaveNotice] = useState('');
  const [copyNotice, setCopyNotice] = useState('');

  const canTelegram = Boolean(tierLimits.telegramAlerts);
  const canMt5 = Boolean(tierLimits.mt5Execution);
  const canAuto = Boolean(tierLimits.mt5AutoExecution);
  const usesRiskPercent = Boolean(tierLimits.autoLotSizing);

  const applyMt5Status = useCallback(
    data => {
      if (!data) {
        setMt5Status(null);
        return;
      }
      setMt5Status(data);
      setRiskPercent(normalizeRiskPercent(data.riskPercent ?? 1));
      setFixedLotSize(data.fixedLotSize ?? 0.01);
      setSymbolSuffix(data.symbolSuffix || '');
      setExecutionMode(data.executionMode || (canAuto ? 'auto' : 'manual'));
    },
    [canAuto]
  );

  const loadMt5Status = useCallback(async () => {
    if (!canMt5) {
      applyMt5Status(null);
      return null;
    }
    const mt5Res = await mt5Api.getStatus();
    applyMt5Status(mt5Res.data);
    return mt5Res.data;
  }, [canMt5, applyMt5Status]);

  /**
   * Two-phase load: Telegram first; MT5 only when NOT Alerts Only
   * (Premium/canAuto always loads MT5; Pro Manual Confirmation loads MT5).
   */
  const loadStatus = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      let nextTgMode = TG_MANUAL;
      if (canTelegram) {
        const telegramRes = await telegramApi.getStatus();
        setStatus(telegramRes.data);
        nextTgMode = normalizeTelegramMode(telegramRes.data.telegramMode);
        setTelegramMode(nextTgMode);
      }

      const shouldLoadMt5 = canMt5 && (canAuto || nextTgMode !== TG_ALERTS);
      if (shouldLoadMt5) {
        await loadMt5Status();
      } else {
        applyMt5Status(null);
      }
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load auto trading status.');
    } finally {
      setLoading(false);
    }
  }, [canTelegram, canMt5, canAuto, loadMt5Status, applyMt5Status]);

  useEffect(() => {
    if (canTelegram || canMt5) {
      loadStatus();
    } else {
      setLoading(false);
    }
  }, [canTelegram, canMt5, loadStatus]);

  useEffect(() => {
    if (!mt5PairInfo?.expiresAt) {
      setPairCountdown('');
      return undefined;
    }
    const tick = () => setPairCountdown(formatCountdown(mt5PairInfo.expiresAt));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [mt5PairInfo?.expiresAt]);

  const resolvedTgMode = normalizeTelegramMode(status?.telegramMode || telegramMode);
  const isAlertsOnly = !canAuto && resolvedTgMode === TG_ALERTS;
  const isManualConfirm = !canAuto && !isAlertsOnly;
  const showMt5Ui = canMt5 && (canAuto || isManualConfirm);

  useEffect(() => {
    if (!showMt5Ui) return undefined;
    const id = setInterval(() => {
      mt5Api
        .getStatus()
        .then(res => setMt5Status(res.data))
        .catch(() => {});
    }, 15000);
    return () => clearInterval(id);
  }, [showMt5Ui]);

  if (!canTelegram && !canMt5) {
    return (
      <div className="insights-section auto-trading-page">
        <div className="auto-trading-lock">
          <h3>Auto Trading</h3>
          <p>Telegram notifications and MT5 execution require Pro or Premium.</p>
          <button type="button" className="btn-fetch" onClick={onNavigatePricing}>
            View plans
          </button>
        </div>
      </div>
    );
  }

  const generateLinkCode = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await telegramApi.createLinkCode();
      setLinkInfo(res.data);
      await loadStatus();
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to generate link code.');
    } finally {
      setBusy(false);
    }
  };

  const startMt5Pair = async () => {
    setBusy(true);
    setError('');
    setCopyNotice('');
    try {
      const res = await mt5Api.startPair();
      setMt5PairInfo(res.data);
      await loadStatus();
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to start MT5 pairing.');
    } finally {
      setBusy(false);
    }
  };

  const copyPairCode = async () => {
    if (!mt5PairInfo?.pairCode) return;
    try {
      await navigator.clipboard.writeText(mt5PairInfo.pairCode);
      setCopyNotice('Copied');
      setTimeout(() => setCopyNotice(''), 1500);
    } catch {
      setCopyNotice('Select and copy manually');
    }
  };

  const revokeDevice = async deviceId => {
    if (!deviceId) return;
    setBusy(true);
    setError('');
    try {
      const res = await mt5Api.revokeDevice(deviceId);
      if (res.data?.status) setMt5Status(res.data.status);
      else await loadStatus();
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to disconnect device.');
    } finally {
      setBusy(false);
    }
  };

  const saveTelegramMode = async nextMode => {
    const mode = normalizeTelegramMode(nextMode);
    setBusy(true);
    setError('');
    setSaveNotice('');
    try {
      // Mode switch uses Telegram settings only — never MT5 updateSettings.
      const res = await telegramApi.updateSettings({ telegramMode: mode });
      if (res.data?.status) setStatus(res.data.status);
      const savedMode = normalizeTelegramMode(res.data?.telegramMode || mode);
      setTelegramMode(savedMode);
      setMt5PairInfo(null);
      if (savedMode === TG_ALERTS) {
        applyMt5Status(null);
        setSaveNotice('Saved: Alerts Only — no MT5 required.');
      } else {
        // Alerts Only → Manual Confirmation: fetch MT5 status and show Pair UI.
        if (canMt5) {
          try {
            await loadMt5Status();
          } catch {
            /* Pair UI still shown; status may load on next poll */
          }
        }
        setSaveNotice('Saved: Manual Confirmation — pair MT5 to approve trades.');
      }
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to save Telegram behaviour.');
    } finally {
      setBusy(false);
    }
  };

  const saveMt5Settings = async () => {
    setBusy(true);
    setError('');
    setSaveNotice('');
    try {
      const payload = {
        riskPercent: normalizeRiskPercent(riskPercent),
        fixedLotSize: Number(fixedLotSize),
        symbolSuffix: symbolSuffix.trim()
      };
      if (canAuto) {
        payload.executionMode = executionMode;
      } else {
        payload.executionMode = 'manual';
      }
      const res = await mt5Api.updateSettings(payload);
      const nextStatus = res.data.status;
      setMt5Status(nextStatus);
      if (nextStatus?.riskPercent != null) {
        setRiskPercent(normalizeRiskPercent(nextStatus.riskPercent));
      }
      if (nextStatus?.fixedLotSize != null) {
        setFixedLotSize(nextStatus.fixedLotSize);
      }
      if (nextStatus?.executionMode) {
        setExecutionMode(nextStatus.executionMode);
      }
      setSaveNotice(
        usesRiskPercent
          ? `Saved risk: ${normalizeRiskPercent(nextStatus?.riskPercent ?? riskPercent)}% per trade.`
          : `Saved fixed lot size: ${nextStatus?.fixedLotSize ?? fixedLotSize}.`
      );
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to save MT5 settings.');
    } finally {
      setBusy(false);
    }
  };

  const unlinkTelegram = async () => {
    setBusy(true);
    setError('');
    try {
      await telegramApi.unlink();
      setLinkInfo(null);
      await loadStatus();
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to unlink Telegram.');
    } finally {
      setBusy(false);
    }
  };

  const toggleAlerts = async enabled => {
    setBusy(true);
    setError('');
    try {
      const res = await telegramApi.toggle(enabled);
      setStatus(res.data.status);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to update Telegram alerts.');
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return <div className="loading-state">Loading auto trading setup…</div>;
  }

  const eaConnected = Boolean(mt5Status?.linked);
  const mt5Enabled = mt5Status?.enabled !== false;
  const resolvedMode = mt5Status?.executionMode || executionMode;
  const isAutoMode = resolvedMode === 'auto';
  const modeLabel =
    mt5Status?.executionModeLabel ||
    (isAutoMode ? 'Automatic (Premium)' : 'Manual Confirmation (Pro)');
  const confirmWindowLabel = mt5Status?.manualConfirmWindowLabel || '3 min';
  const pairExpired =
    mt5PairInfo?.expiresAt && new Date(mt5PairInfo.expiresAt).getTime() <= Date.now();

  return (
    <div className="insights-section telegram-setup auto-trading-page">
      <header className="auto-trading-header">
        <p className="auto-trading-kicker">Execution</p>
        <h3>Auto Trading</h3>
        <p>
          {canAuto
            ? 'Premium Automatic queues every entry to MT5. Telegram is optional for notifications.'
            : 'Pro: choose Telegram Behaviour — Manual Confirmation (MT5) or Alerts Only (any platform).'}
        </p>
      </header>

      {error && (
        <div className="mpesa-alert mpesa-alert-error" role="alert">
          {error}
        </div>
      )}

      {!canAuto && canTelegram && (
        <section className="auto-trading-card">
          <div className="auto-trading-card-head">
            <div>
              <h4>Telegram Behaviour</h4>
              <p>Does not change MT5 executionMode (stays Manual). Only how Telegram behaves.</p>
            </div>
            <span className={`auto-status-pill ${isAlertsOnly ? 'is-idle' : 'is-live'}`}>
              {isAlertsOnly ? 'Alerts Only' : 'Manual Confirmation'}
            </span>
          </div>

          <div className="execution-mode-list" role="radiogroup" aria-label="Telegram Behaviour">
            <label className={`execution-mode-option${isManualConfirm ? ' is-selected' : ''}`}>
              <input
                type="radio"
                name="telegram-mode"
                checked={isManualConfirm}
                disabled={busy}
                onChange={() => {
                  setTelegramMode(TG_MANUAL);
                  saveTelegramMode(TG_MANUAL);
                }}
              />
              <span>
                <strong>Manual Confirmation</strong>
                <small>Requires MT5 pairing. Approve every trade with Execute / Ignore in Telegram.</small>
              </span>
            </label>
            <label className={`execution-mode-option${isAlertsOnly ? ' is-selected' : ''}`}>
              <input
                type="radio"
                name="telegram-mode"
                checked={isAlertsOnly}
                disabled={busy}
                onChange={() => {
                  setTelegramMode(TG_ALERTS);
                  saveTelegramMode(TG_ALERTS);
                }}
              />
              <span>
                <strong>Alerts Only</strong>
                <small>
                  No MT5 required. Receive Telegram alerts only and trade manually on any broker (MT4, MT5,
                  TradingView, cTrader, Deriv, Binance, etc.).
                </small>
              </span>
            </label>
          </div>
          {saveNotice && <p className="auto-notice is-success">{saveNotice}</p>}
        </section>
      )}

      {isAlertsOnly && (
        <section className="auto-trading-card">
          <div className="auto-trading-card-head">
            <div>
              <h4>Manual Trading</h4>
              <p>Receive alerts instantly. No MT5 required.</p>
            </div>
            <span className={`auto-status-pill ${status?.linked ? 'is-live' : 'is-idle'}`}>
              {status?.linked ? (status.enabled ? 'Connected' : 'Paused') : 'Not linked'}
            </span>
          </div>
          <dl className="auto-status-grid">
            <div>
              <dt>Telegram Connected</dt>
              <dd>{status?.linked ? 'Yes' : 'No — generate a link code below'}</dd>
            </div>
            <div>
              <dt>Alerts Enabled</dt>
              <dd>{status?.enabled !== false ? 'Yes' : 'Paused'}</dd>
            </div>
            <div>
              <dt>Manual Trading</dt>
              <dd>Place trades on your preferred platform</dd>
            </div>
          </dl>
          <p className="auto-notice">
            Pair MT5, devices, heartbeat, broker, balance, and Pair Codes are hidden in Alerts Only. Switch
            back to Manual Confirmation to pair MT5 again.
          </p>
        </section>
      )}

      {showMt5Ui && (
        <section className="auto-trading-card">
          <div className="auto-trading-card-head">
            <div>
              <h4>MT5 execution</h4>
              <p>Compile the EA, allow WebRequest, then pair with an 8-character Pair Code.</p>
            </div>
            <span className={`auto-status-pill ${eaConnected ? (mt5Status?.deviceOnline ? 'is-live' : 'is-idle') : 'is-idle'}`}>
              {eaConnected
                ? mt5Status?.deviceOnline
                  ? 'Connected'
                  : mt5Enabled
                    ? 'Paired'
                    : 'Paused'
                : 'Not connected'}
            </span>
          </div>

          <ol className="auto-setup-steps">
            <li>
              Compile and attach <code>mt5/KachingTradeCopier.mq5</code> (v1.20+) on your MT5 terminal.
            </li>
            <li>
              In MT5: Tools → Options → Expert Advisors → allow WebRequest for your Kaching backend URL.
            </li>
            <li>
              Click <strong>Pair MT5</strong>, enter the 8-character code in the EA <code>PairCode</code> input.
            </li>
            <li>Enable Algo Trading, attach the EA to a chart, and keep it running.</li>
            {canAuto ? (
              <>
                <li>Leave Execution Mode on <strong>Auto</strong> (Premium default).</li>
                <li>Set risk % and broker suffix, save, then wait for balance sync.</li>
              </>
            ) : (
              <>
                <li>Set fixed lot size and broker suffix, then save.</li>
                <li>
                  Confirm each entry with <strong>Execute</strong> on the Telegram alert to queue it for the EA.
                </li>
              </>
            )}
          </ol>

          {!eaConnected ? (
            <div className="telegram-actions">
              <button type="button" className="btn-fetch" disabled={busy} onClick={startMt5Pair}>
                {busy ? 'Working…' : 'Pair MT5'}
              </button>
            </div>
          ) : (
            <>
              <div className="telegram-actions" style={{ marginBottom: 12 }}>
                <button type="button" className="btn-fetch" disabled={busy} onClick={startMt5Pair}>
                  {busy ? 'Working…' : 'Pair another device'}
                </button>
              </div>
              <dl className="auto-status-grid">
                <div>
                  <dt>Status</dt>
                  <dd>{mt5Enabled ? 'Active' : 'Paused'}</dd>
                </div>
                <div>
                  <dt>EA Connected</dt>
                  <dd>
                    Yes
                    {mt5Status.accountBalance != null
                      ? ` · Balance ${mt5Status.accountBalance} ${mt5Status.accountCurrency || 'USD'}`
                      : ' · waiting for balance sync'}
                  </dd>
                </div>
                <div>
                  <dt>Lot Size</dt>
                  <dd>
                    {usesRiskPercent
                      ? 'Auto from balance × risk %'
                      : `${mt5Status.fixedLotSize ?? fixedLotSize}`}
                  </dd>
                </div>
                <div>
                  <dt>Execution Mode</dt>
                  <dd>
                    {modeLabel}
                    {isAutoMode
                      ? ' — entry signals queue to MT5 immediately'
                      : ` — Telegram Execute/Ignore within ${confirmWindowLabel}`}
                  </dd>
                </div>
                {mt5Status.lastSyncAt && (
                  <div>
                    <dt>Last sync</dt>
                    <dd>{new Date(mt5Status.lastSyncAt).toLocaleString()}</dd>
                  </div>
                )}
                <div>
                  <dt>Pending executions</dt>
                  <dd>{mt5Status.pendingCount || 0}</dd>
                </div>
              </dl>
            </>
          )}

          {Array.isArray(mt5Status?.devices) && mt5Status.devices.length > 0 && (
            <div className="mt5-devices">
              <h5>Authorized devices</h5>
              <ul className="mt5-device-list">
                {mt5Status.devices.map(device => (
                  <li key={device.deviceId} className="mt5-device-row">
                    <div>
                      <strong>{device.friendlyName || device.label || 'MT5 Terminal'}</strong>
                      <span
                        className={`mt5-device-dot ${device.online || device.status === 'Active' ? 'is-online' : 'is-offline'}`}
                      >
                        {device.status === 'Active' || device.online ? 'Connected' : 'Offline'}
                      </span>
                      <p>
                        {[device.broker, device.platform, device.accountNumber ? `#${device.accountNumber}` : null]
                          .filter(Boolean)
                          .join(' · ') || 'MT5'}
                      </p>
                      <p className="mt5-device-meta">Last active: {formatDeviceActive(device.lastHeartbeatAt)}</p>
                    </div>
                    <button
                      type="button"
                      className="btn-small btn-danger"
                      disabled={busy}
                      onClick={() => revokeDevice(device.deviceId)}
                    >
                      Disconnect
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {eaConnected && (
            <>
              <div className="auto-settings-grid">
                {canAuto && (
                  <label className="auto-field">
                    <span>Execution Mode</span>
                    <select
                      value={executionMode}
                      onChange={e => setExecutionMode(e.target.value)}
                      disabled={!canAuto}
                    >
                      <option value="auto">Automatic (Premium) — queue every entry to MT5</option>
                      <option value="manual">
                        Manual Confirmation — Telegram Execute/Ignore (time-limited)
                      </option>
                    </select>
                  </label>
                )}
                {usesRiskPercent ? (
                  <div className="mt5-risk-field">
                    <label htmlFor="mt5-risk-percent">Risk per trade (%)</label>
                    <div className="mt5-risk-presets" role="group" aria-label="Risk percent presets">
                      {RISK_PRESETS.map(preset => (
                        <button
                          key={preset}
                          type="button"
                          className={`btn-small mt5-risk-preset${
                            Number(riskPercent) === preset ? ' is-active' : ''
                          }`}
                          disabled={busy}
                          onClick={() => {
                            setRiskPercent(preset);
                            setSaveNotice('');
                          }}
                        >
                          {preset}%
                        </button>
                      ))}
                    </div>
                    <input
                      id="mt5-risk-percent"
                      type="number"
                      min={RISK_MIN}
                      max={RISK_MAX}
                      step="0.1"
                      value={riskPercent}
                      onChange={e => {
                        setRiskPercent(e.target.value);
                        setSaveNotice('');
                      }}
                      onBlur={() => setRiskPercent(normalizeRiskPercent(riskPercent))}
                    />
                  </div>
                ) : (
                  <label className="auto-field">
                    <span>Fixed lot size (Pro)</span>
                    <input
                      type="number"
                      min="0.01"
                      max="100"
                      step="0.01"
                      value={fixedLotSize}
                      onChange={e => {
                        setFixedLotSize(e.target.value);
                        setSaveNotice('');
                      }}
                    />
                  </label>
                )}
                <label className="auto-field">
                  <span>Broker symbol suffix</span>
                  <input
                    type="text"
                    placeholder="e.g. .m or leave blank"
                    value={symbolSuffix}
                    onChange={e => setSymbolSuffix(e.target.value)}
                  />
                </label>
              </div>

              <div className="telegram-actions">
                <button type="button" className="btn-small" disabled={busy} onClick={saveMt5Settings}>
                  {usesRiskPercent ? 'Save risk settings' : 'Save settings'}
                </button>
                <button type="button" className="btn-fetch" disabled={busy} onClick={startMt5Pair}>
                  Re-pair / add device
                </button>
              </div>
              {saveNotice && showMt5Ui && <p className="auto-notice is-success">{saveNotice}</p>}
            </>
          )}

          {mt5PairInfo && (
            <div className="telegram-link-box mt5-pair-box">
              <p>
                <strong>Pair Code</strong> — enter this in the EA <code>PairCode</code> input.
              </p>
              <div className="mt5-pair-code">
                <pre className="mt5-pair-code-value" aria-label="MT5 pair code">
                  {mt5PairInfo.pairCode}
                </pre>
                <p className={`mt5-pair-expiry${pairExpired ? ' is-expired' : ''}`}>
                  {pairExpired ? 'Expired' : pairCountdown}
                </p>
              </div>
              <div className="mt5-pair-actions">
                {!pairExpired && (
                  <button type="button" className="btn-small" disabled={busy} onClick={copyPairCode}>
                    {copyNotice || 'Copy'}
                  </button>
                )}
                <button type="button" className="btn-fetch" disabled={busy} onClick={startMt5Pair}>
                  {busy ? 'Working…' : pairExpired ? 'Generate New Code' : 'Regenerate'}
                </button>
              </div>
            </div>
          )}
        </section>
      )}

      {canTelegram && (
        <section className="auto-trading-card">
          <div className="auto-trading-card-head">
            <div>
              <h4>{isAlertsOnly ? 'Link Telegram' : 'Telegram notifications'}</h4>
              <p>
                {isAlertsOnly
                  ? 'Required for Alerts Only — signals arrive here instantly.'
                  : 'Optional alert messages. Telegram does not connect to MT5.'}
              </p>
            </div>
            <span className={`auto-status-pill ${status?.linked ? 'is-live' : 'is-idle'}`}>
              {status?.linked ? (status.enabled ? 'Alerts on' : 'Paused') : 'Not linked'}
            </span>
          </div>

          {!status?.configured && (
            <div className="auto-notice is-warn">
              Telegram bot is not configured on the server yet. Add <code>TELEGRAM_BOT_TOKEN</code> to{' '}
              <code>backend/.env</code>.
            </div>
          )}

          {status && (
            <dl className="auto-status-grid">
              <div>
                <dt>Bot</dt>
                <dd>@{status.botUsername}</dd>
              </div>
              <div>
                <dt>Linked</dt>
                <dd>{status.linked ? `yes (@${status.username || 'chat'})` : 'no'}</dd>
              </div>
              <div>
                <dt>Alerts</dt>
                <dd>{status.enabled ? 'on' : 'off'}</dd>
              </div>
            </dl>
          )}

          <div className="telegram-actions">
            <button
              type="button"
              className="btn-fetch"
              disabled={busy || !status?.configured}
              onClick={generateLinkCode}
            >
              {busy ? 'Working…' : 'Generate Telegram link code'}
            </button>
            {status?.linked && (
              <>
                <button
                  type="button"
                  className="btn-small"
                  disabled={busy}
                  onClick={() => toggleAlerts(!status.enabled)}
                >
                  {status.enabled ? 'Pause alerts' : 'Resume alerts'}
                </button>
                <button type="button" className="btn-small btn-danger" disabled={busy} onClick={unlinkTelegram}>
                  Unlink Telegram
                </button>
              </>
            )}
          </div>

          {linkInfo && (
            <div className="telegram-link-box">
              <p>
                <strong>Link code:</strong> <code>{linkInfo.code}</code>
              </p>
              <p>
                In Telegram, message <code>@{linkInfo.botUsername}</code>:
              </p>
              <pre>/link {linkInfo.code}</pre>
            </div>
          )}
        </section>
      )}

      <section className="auto-trading-card auto-trading-howto">
        <h4>After setup — how trades run</h4>
        <ol className="auto-setup-steps">
          <li>TradingView Pine sends an entry signal via webhook.</li>
          <li>
            <strong>Alerts Only (Pro)</strong>: Telegram alert with levels — no MT5 queue. Trade manually.
          </li>
          <li>
            <strong>Manual Confirmation (Pro)</strong>: Telegram Execute / Ignore within {confirmWindowLabel} →
            MT5 queue.
          </li>
          <li>
            <strong>Automatic (Premium)</strong>: MT5 queue immediately. Telegram informational only.
          </li>
        </ol>
      </section>
    </div>
  );
}
