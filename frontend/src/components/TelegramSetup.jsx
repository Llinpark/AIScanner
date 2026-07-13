import { useCallback, useEffect, useState } from 'react';
import { telegramApi } from '../services/api';

export default function TelegramSetup({ tierLimits, onNavigatePricing }) {
  const [status, setStatus] = useState(null);
  const [linkInfo, setLinkInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const loadStatus = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await telegramApi.getStatus();
      setStatus(res.data);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load Telegram status.');
    } finally {
      setLoading(false);
    }
  }, []);

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
          Telegram alerts require Pro or Premium.{' '}
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
    return <div className="loading-state">Loading Telegram setup…</div>;
  }

  return (
    <div className="insights-section telegram-setup">
      <div className="insights-section-header">
        <h3>Telegram Bot Alerts</h3>
        <p>Receive Kaching Entry, SL, and TP alerts directly in Telegram.</p>
      </div>

      {error && <div className="feature-lock">{error}</div>}

      {!status?.configured && (
        <div className="feature-lock">
          Telegram bot is not configured on the server yet. Add <code>TELEGRAM_BOT_TOKEN</code> to{' '}
          <code>backend/.env</code>.
        </div>
      )}

      {status && (
        <div className="telegram-status-card">
          <p>
            <strong>Bot:</strong> @{status.botUsername}
          </p>
          <p>
            <strong>Linked:</strong> {status.linked ? `yes (@${status.username || 'chat'})` : 'no'}
          </p>
          <p>
            <strong>Alerts:</strong> {status.enabled ? 'on' : 'off'}
          </p>
          {status.linkedAt && (
            <p>
              <strong>Linked at:</strong> {new Date(status.linkedAt).toLocaleString()}
            </p>
          )}
        </div>
      )}

      <div className="telegram-actions">
        <button type="button" className="btn-fetch" disabled={busy || !status?.configured} onClick={generateLinkCode}>
          {busy ? 'Working…' : 'Generate link code'}
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
            <strong>Expires:</strong> {new Date(linkInfo.expiresAt).toLocaleString()}
          </p>
          <p>
            In Telegram, message <code>@{linkInfo.botUsername}</code>:
          </p>
          <pre>/link {linkInfo.code}</pre>
          {linkInfo.botUrl && (
            <p>
              Or open{' '}
              <a href={linkInfo.botUrl} target="_blank" rel="noreferrer">
                {linkInfo.botUrl}
              </a>{' '}
              and tap Start.
            </p>
          )}
          <ol>
            {(linkInfo.instructions || []).map(step => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}
