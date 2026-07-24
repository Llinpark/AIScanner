import { useCallback, useEffect, useState } from 'react';
import { mt5Api, telegramApi } from '../services/api';

export default function TelegramSetup({ tierLimits, onNavigatePricing }) {
  const [status, setStatus] = useState(null);
  const [mt5Status, setMt5Status] = useState(null);
  const [linkInfo, setLinkInfo] = useState(null);
  const [mt5LinkInfo, setMt5LinkInfo] = useState(null);
  const [riskPercent, setRiskPercent] = useState(1);
  const [fixedLotSize, setFixedLotSize] = useState(0.01);
  const [symbolSuffix, setSymbolSuffix] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const loadStatus = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const requests = [telegramApi.getStatus()];
      if (tierLimits.mt5Execution) {
        requests.push(mt5Api.getStatus());
      }
      const [telegramRes, mt5Res] = await Promise.all(requests);
      setStatus(telegramRes.data);
      if (mt5Res) {
        setMt5Status(mt5Res.data);
        setRiskPercent(mt5Res.data.riskPercent ?? 1);
        setFixedLotSize(mt5Res.data.fixedLotSize ?? 0.01);
        setSymbolSuffix(mt5Res.data.symbolSuffix || '');
      }
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load trade copier status.');
    } finally {
      setLoading(false);
    }
  }, [tierLimits.mt5Execution]);

  useEffect(() => {
    if (tierLimits.telegramAlerts) {
      loadStatus();
    } else {
      setLoading(false);
    }
  }, [tierLimits.telegramAlerts, loadStatus]);

  if (!tierLimits.telegramAlerts) {
    return (
      <div className="insights-section">
        <div className="feature-lock">
          Telegram trade copier requires Pro or Premium.{' '}
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
    try {
      const res = await mt5Api.updateSettings({
        riskPercent: Number(riskPercent),
        fixedLotSize: Number(fixedLotSize),
        symbolSuffix: symbolSuffix.trim()
      });
      setMt5Status(res.data.status);
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
    return <div className="loading-state">Loading trade copier setup…</div>;
  }

  return (
    <div className="insights-section telegram-setup">
      <div className="insights-section-header">
        <h3>Telegram Trade Copier</h3>
        <p>
          TradingView webhook → Telegram alert → tap <strong>Execute on MT5</strong> (Pro+). Entry, stop loss,
          take profit, and lot size are filled automatically. Premium auto-sizes lots from your synced MT5 balance.
        </p>
      </div>

      {error && <div className="feature-lock">{error}</div>}

      {!status?.configured && (
        <div className="feature-lock">
          Telegram bot is not configured on the server yet. Add <code>TELEGRAM_BOT_TOKEN</code> to{' '}
          <code>backend/.env</code>.
        </div>
      )}

      <div className="telegram-status-card">
        <h4>Step 1 — Link Telegram</h4>
        {status && (
          <>
            <p>
              <strong>AI:</strong> @{status.botUsername}
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
          <button type="button" className="btn-fetch" disabled={busy || !status?.configured} onClick={generateLinkCode}>
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

      {tierLimits.mt5Execution ? (
        <div className="telegram-status-card">
          <h4>Step 2 — Connect MT5 EA</h4>
          <p>
            Install <code>mt5/KachingTradeCopier.mq5</code> on your terminal, allow the backend URL in MT5 WebRequest
            settings, and paste the link token below.
          </p>

          {mt5Status && (
            <>
              <p>
                <strong>EA linked:</strong> {mt5Status.linked ? 'yes' : 'no'}
              </p>
              <p>
                <strong>MT5 balance:</strong>{' '}
                {mt5Status.accountBalance != null
                  ? `${mt5Status.accountBalance} ${mt5Status.accountCurrency || 'USD'}`
                  : 'waiting for EA sync'}
              </p>
              <p>
                <strong>Pending executions:</strong> {mt5Status.pendingCount || 0}
              </p>
              {mt5Status.lastSyncAt && (
                <p>
                  <strong>Last sync:</strong> {new Date(mt5Status.lastSyncAt).toLocaleString()}
                </p>
              )}
            </>
          )}

          <div className="telegram-actions">
            <button type="button" className="btn-fetch" disabled={busy} onClick={generateMt5Token}>
              {busy ? 'Working…' : 'Generate MT5 link token'}
            </button>
            <button type="button" className="btn-small" disabled={busy} onClick={saveMt5Settings}>
              Save risk settings
            </button>
          </div>

          <div className="form-row">
            {tierLimits.autoLotSizing ? (
              <label>
                Risk per trade (%) — Premium auto lot
                <input
                  type="number"
                  min="0.1"
                  max="10"
                  step="0.1"
                  value={riskPercent}
                  onChange={e => setRiskPercent(e.target.value)}
                />
              </label>
            ) : (
              <label>
                Fixed lot size (Pro)
                <input
                  type="number"
                  min="0.01"
                  max="100"
                  step="0.01"
                  value={fixedLotSize}
                  onChange={e => setFixedLotSize(e.target.value)}
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
          {tierLimits.autoLotSizing && mt5Status && mt5Status.accountBalance == null && (
            <p className="page-notice info-box">
              Waiting for EA balance sync — Premium auto lot sizing will not queue trades until SyncAccount reports a
              balance.
            </p>
          )}
          {(tierLimits.trailingStop || tierLimits.breakEvenAutomation) && (
            <p className="page-notice info-box">
              Install EA v1.10+ so trailing stop and break-even run on open positions after fill (OnTick management).
            </p>
          )}

          {mt5LinkInfo && (
            <div className="telegram-link-box">
              <p>
                <strong>MT5 link token:</strong>
              </p>
              <pre>{mt5LinkInfo.token}</pre>
              <p>
                <strong>Backend URL:</strong> <code>{mt5LinkInfo.bridgeUrl?.replace('/bridge', '') || mt5Status?.bridgeUrl?.replace('/bridge', '')}</code>
              </p>
              <ol>
                {(mt5LinkInfo.instructions || []).map(step => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
            </div>
          )}
        </div>
      ) : (
        <div className="feature-lock">
          One-click MT5 execution is available on Pro and Premium.{' '}
          <button type="button" className="link-btn" onClick={onNavigatePricing}>
            Upgrade
          </button>
        </div>
      )}

      <div className="telegram-status-card">
        <h4>How it works</h4>
        <ol>
          <li>TradingView Pine sends an entry signal with Kaching Entry, SL, and TP levels via webhook.</li>
          <li>Kaching stores the signal and pushes it to Telegram (and your live dashboard).</li>
          <li>Pro and Premium users tap <strong>Execute on MT5</strong> — entry, SL, TP filled automatically.</li>
          <li>Pro uses fixed lot size; Premium auto-sizes from synced MT5 balance × risk %.</li>
          <li>The MT5 EA places the trade, then manages trailing stop and break-even on the open position.</li>
        </ol>
      </div>
    </div>
  );
}
