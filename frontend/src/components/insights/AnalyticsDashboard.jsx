import { useEffect, useState } from 'react';
import { analyticsApi } from '../../services/api';

function EquityChart({ points }) {
  if (!points?.length) {
    return <div className="chart-empty">Close trades to build an equity curve.</div>;
  }

  const values = points.map(p => p.cumulativeR);
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 1);
  const range = max - min || 1;
  const width = 600;
  const height = 160;
  const padding = 12;

  const coords = points.map((point, index) => {
    const x = padding + (index / Math.max(points.length - 1, 1)) * (width - padding * 2);
    const y = height - padding - ((point.cumulativeR - min) / range) * (height - padding * 2);
    return `${x},${y}`;
  });

  return (
    <div className="equity-chart-wrap">
      <svg viewBox={`0 0 ${width} ${height}`} className="equity-chart" role="img" aria-label="Equity curve">
        <polyline fill="none" stroke="var(--accent-color)" strokeWidth="2.5" points={coords.join(' ')} />
      </svg>
      <div className="chart-labels">
        <span>Start</span>
        <strong>{values[values.length - 1]}R cumulative</strong>
      </div>
    </div>
  );
}

function BarChart({ rows, valueKey, labelKey }) {
  if (!rows?.length) return null;
  const max = Math.max(...rows.map(r => r[valueKey] || 0), 1);

  return (
    <div className="bar-chart">
      {rows.map(row => (
        <div key={row[labelKey]} className="bar-row">
          <span className="bar-label">{row[labelKey]}</span>
          <div className="bar-track">
            <div className="bar-fill" style={{ width: `${((row[valueKey] || 0) / max) * 100}%` }} />
          </div>
          <span className="bar-value">{row[valueKey]}</span>
        </div>
      ))}
    </div>
  );
}

export default function AnalyticsDashboard({ tierLimits, onNavigatePricing }) {
  const [summary, setSummary] = useState(null);
  const [timeseries, setTimeseries] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!tierLimits.performanceDashboard) {
      setLoading(false);
      return;
    }

    Promise.all([analyticsApi.getSummary(), analyticsApi.getTimeseries()])
      .then(([summaryRes, tsRes]) => {
        setSummary(summaryRes.data);
        setTimeseries(tsRes.data);
      })
      .catch(err => setError(err.response?.data?.message || 'Failed to load analytics.'))
      .finally(() => setLoading(false));
  }, [tierLimits.performanceDashboard]);

  if (!tierLimits.performanceDashboard) {
    return (
      <div className="insights-section">
        <div className="feature-lock">
          Analytics dashboard requires Pro or Premium.{' '}
          <button type="button" className="link-btn" onClick={onNavigatePricing}>
            Upgrade
          </button>
        </div>
      </div>
    );
  }

  if (loading) return <div className="loading-state">Loading analytics…</div>;
  if (error) return <div className="feature-lock">{error}</div>;
  if (!summary) return null;

  return (
    <div className="insights-section">
      <div className="insights-section-header">
        <h3>Analytics</h3>
        <p>Real win rate based on closed TP/SL outcomes</p>
      </div>

      <div className="analytics-grid">
        <div className="analytics-stat">
          <span>Win rate</span>
          <strong>{summary.winRate}%</strong>
        </div>
        <div className="analytics-stat">
          <span>Closed trades</span>
          <strong>{summary.closedTrades}</strong>
        </div>
        <div className="analytics-stat">
          <span>Open trades</span>
          <strong>{summary.openTrades}</strong>
        </div>
        <div className="analytics-stat">
          <span>Wins / Losses</span>
          <strong>
            {summary.wins} / {summary.losses}
          </strong>
        </div>
        <div className="analytics-stat">
          <span>Total R</span>
          <strong>{summary.totalR}R</strong>
        </div>
        <div className="analytics-stat">
          <span>Avg R / trade</span>
          <strong>{summary.avgR}R</strong>
        </div>
      </div>

      <div className="analytics-panels">
        <div className="analytics-panel">
          <h4>Equity curve (R multiples)</h4>
          <EquityChart points={timeseries?.equityCurve || []} />
        </div>

        <div className="analytics-panel">
          <h4>Daily closed trades</h4>
          <BarChart rows={timeseries?.timeseries || []} valueKey="closed" labelKey="date" />
        </div>

        <div className="analytics-panel">
          <h4>Pattern performance</h4>
          {(timeseries?.patternStats || []).length === 0 ? (
            <div className="chart-empty">No closed pattern trades yet.</div>
          ) : (
            <div className="pattern-stats-table">
              <table>
                <thead>
                  <tr>
                    <th>Pattern</th>
                    <th>Trades</th>
                    <th>Win rate</th>
                    <th>Avg R</th>
                  </tr>
                </thead>
                <tbody>
                  {(timeseries?.patternStats || []).map(row => (
                    <tr key={row.pattern}>
                      <td>{row.label || row.pattern}</td>
                      <td>{row.total}</td>
                      <td>{row.winRate}%</td>
                      <td>{row.avgR}R</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
