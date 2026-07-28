import { useCallback, useEffect, useState } from 'react';
import { mt5Api, telegramApi } from '../services/api';

const RISK_PRESETS = [0.5, 1, 2, 3, 5];
const RISK_MIN = 0.1;
/** Safety ceiling only — not a product recommendation. Must match backend RISK_PERCENT_MAX. */
const RISK_MAX = 100;

function normalizeRiskPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.min(RISK_MAX, Math.max(RISK_MIN, Number(n.toFixed(2))));
}

export default function TelegramSetup({ tierLimits, onNavigatePricing }) {
  const [status, setStatus] = useState(null);
  const [mt5Status, setMt5Status] = useState(null);
  const [linkInfo, setLinkInfo] = useState(null);
  const [mt5LinkInfo, setMt5LinkInfo] = useState(null);
  const [riskPercent, setRiskPercent] = useState(1);
  const [fixedLotSize, setFixedLotSize] = useState(0.01);
  const [symbolSuffix, setSymbolSuffix] = useState('');
  const [executionMode, setExecutionMode] = useState('manual');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saveNotice, setSaveNotice] = useState('');

  const canTelegram = Boolean(tierLimits.telegramAlerts);
  const canMt5 = Boolean(tierLimits.mt5Execution);
  const canAuto = Boolean(tierLimits.mt5AutoExecution);
  const usesRiskPercent = Boolean(tierLimits.autoLotSizing);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const requests = [];
      if (canTelegram) requests.push(telegramApi.getStatus());
      else requests.push(Promise.resolve(null));
      if (canMt5) requests.push(mt5Api.getStatus());
      else requests.push(Promise.resolve(null));

      const [telegramRes, mt5Res] = await Promise.all(requests);
      if (telegramRes) setStatus(telegramRes.data);
      if (mt5Res) {
        setMt5Status(mt5Res.data);
        setRiskPercent(normalizeRiskPercent(mt5Res.data.riskPercent ?? 1));
        setFixedLotSize(mt5Res.data.fixedLotSize ?? 0.01);
        setSymbolSuffix(mt5Res.data.symbolSuffix || '');
        setExecutionMode(mt5Res.data.executionMode || (canAuto ? 'auto' : 'manual'));
      }
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load auto trading status.');
    } finally {
      setLoading(false);
    }
  }, [canTelegram, canMt5, canAuto]);

  useEffect(() => {
    if (canTelegram || canMt5) {
      loadStatus();
    } else {
      setLoading(false);
    }
  }, [canTelegram, canMt5, loadStatus]);

  if (!canTelegram && !canMt5) {
    return (
      <div className="insights-section">
        <div className="feature-lock">
          Auto Trading (Telegram notifications + MT5) requires Pro or Premium.{' '}
          <button type="button" className="link-btn" onClick={onNavigatePricing}>
            Upgrade
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

  const generateMt5Token = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await mt5Api.createLinkToken();
      setMt5LinkInfo(res.data);
      await loadStatus();
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to generate MT5 link token.');
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
  const brokerLabel = mt5Status?.symbolSuffix
    ? `Broker suffix ${mt5Status.symbolSuffix}`
    : 'Default symbols (no suffix)';

  return (
    <div className="insights-section telegram-setup">
      <div className="insights-section-header">
        <h3>Auto Trading</h3>
        <p>
          TradingView signals go to your live dashboard, email, Telegram (notifications), and MT5. MT5 execution does
          not depend on Telegram.
        </p>
      </div>

      {error && <div className="feature-lock">{error}</div>}

      {canMt5 && (
        <div className="telegram-status-card">
          <h4>MT5 Auto Trading</h4>
          {!eaConnected ? (
            <>
              <p>
                Connect your MetaTrader 5 Expert Advisor to queue and place trades. Install{' '}
                <code>mt5/KachingTradeCopier.mq5</code>, allow the backend URL in MT5 WebRequest settings, then generate
                a link token.
              </p>
              <div className="telegram-actions">
                <button type="button" className="btn-fetch" disabled={busy} onClick={generateMt5Token}>
                  {busy ? 'Working…' : 'Connect MT5'}
                </button>
              </div>
            </>
          ) : (
            <>
              <p>
                <strong>Status:</strong> {mt5Enabled ? 'Active' : 'Paused'}
              </p>
              <p>
                <strong>Broker:</strong> {brokerLabel}
              </p>
              <p>
                <strong>EA Connected:</strong> yes
                {mt5Status.accountBalance != null
                  ? ` · Balance ${mt5Status.accountBalance} ${mt5Status.accountCurrency || 'USD'}`
                  : ' · waiting for balance sync'}
              </p>
              <p>
                <strong>Lot Size:</strong>{' '}
                {usesRiskPercent
                  ? 'Auto from balance × risk %'
                  : `${mt5Status.fixedLotSize ?? fixedLotSize}`}
              </p>
              <p>
                <strong>Execution Mode:</strong>{' '}
                {(mt5Status.executionMode || executionMode) === 'auto' ? 'Auto' : 'Manual'}
              </p>
              {mt5Status.lastSyncAt && (
                <p>
                  <strong>Last sync:</strong> {new Date(mt5Status.lastSyncAt).toLocaleString()}
                </p>
              )}
              <p>
                <strong>Pending executions:</strong> {mt5Status.pendingCount || 0}
              </p>
            </>
          )}

          {eaConnected && (
            <>
              <div className="form-row">
                {canAuto && (
                  <label>
                    Execution Mode
                    <select
                      value={executionMode}
                      onChange={e => setExecutionMode(e.target.value)}
                      disabled={!canAuto}
                    >
                      <option value="auto">Auto — queue on every entry signal</option>
                      <option value="manual">Manual — Execute button only</option>
                    </select>
                  </label>
                )}
                {!canAuto && (
                  <p className="page-notice info-box">
                    Pro uses Manual execution: tap Execute in Telegram to queue. Upgrade to Premium for Automatic MT5
                    execution.
                  </p>
                )}
                {usesRiskPercent ? (
                  <div className="mt5-risk-field">
                    <label htmlFor="mt5-risk-percent">Risk per trade (%)</label>
                    <p className="mt5-risk-hint">Choose how much of your balance to risk on each trade.</p>
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
                    <span className="mt5-risk-range">Allowed range: {RISK_MIN}% – {RISK_MAX}%</span>
                  </div>
                ) : (
                  <label>
                    Fixed lot size (Pro)
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
                <label>
                  Broker symbol suffix
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
                <button type="button" className="btn-fetch" disabled={busy} onClick={generateMt5Token}>
                  Regenerate MT5 token
                </button>
              </div>
              {saveNotice && <p className="page-notice info-box">{saveNotice}</p>}

              {usesRiskPercent && mt5Status.accountBalance == null && (
                <p className="page-notice info-box">
                  Waiting for EA balance sync — Premium auto lot sizing will not queue trades until SyncAccount reports a
                  balance.
                </p>
              )}
              {(tierLimits.trailingStop || tierLimits.breakEvenAutomation) && (
                <p className="page-notice info-box">
                  Install EA v1.10+ so trailing stop and break-even run on open positions after fill.
                </p>
              )}
            </>
          )}

          {mt5LinkInfo && (
            <div className="telegram-link-box">
              <p>
                <strong>MT5 link token:</strong>
              </p>
              <pre>{mt5LinkInfo.token}</pre>
              <p>
                <strong>Backend URL:</strong>{' '}
                <code>
                  {mt5LinkInfo.bridgeUrl?.replace('/bridge', '') ||
                    mt5Status?.bridgeUrl?.replace('/bridge', '')}
                </code>
              </p>
              <ol>
                {(mt5LinkInfo.instructions || []).map(step => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
            </div>
          )}
        </div>
      )}

      {canTelegram && (
        <div className="telegram-status-card">
          <h4>Telegram notifications</h4>
          <p>Telegram delivers alerts only. It does not drive MT5 execution.</p>

          {!status?.configured && (
            <div className="feature-lock">
              Telegram bot is not configured on the server yet. Add <code>TELEGRAM_BOT_TOKEN</code> to{' '}
              <code>backend/.env</code>.
            </div>
          )}

          {status && (
            <>
              <p>
                <strong>Bot:</strong> @{status.botUsername}
              </p>
              <p>
                <strong>Linked:</strong> {status.linked ? `yes (@${status.username || 'chat'})` : 'no'}
              </p>
              <p>
                <strong>Alerts:</strong> {status.enabled ? 'on' : 'off'}
              </p>
            </>
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
        </div>
      )}

      <div className="telegram-status-card">
        <h4>How it works</h4>
        <ol>
          <li>TradingView Pine sends an entry signal with Kaching Entry, SL, and TP levels via webhook.</li>
          <li>Signals are delivered to your live dashboard, email, Telegram, and MT5 as allowed by your plan.</li>
          <li>
            <strong>Manual</strong> (Pro default): Telegram shows Execute — tap to queue for the EA.
          </li>
          <li>
            <strong>Auto</strong> (Premium default): entry signals queue for MT5 immediately without Telegram.
          </li>
          <li>The MT5 EA polls the bridge, places the trade, then manages trailing stop and break-even.</li>
        </ol>
      </div>
    </div>
  );
}
