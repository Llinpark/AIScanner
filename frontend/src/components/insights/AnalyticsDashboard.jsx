import { memo, useEffect, useMemo, useState } from 'react';
import { analyticsApi } from '../../services/api';

const EquityChart = memo(function EquityChart({ points }) {
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
});

const BarChart = memo(function BarChart({ rows, valueKey, labelKey }) {
  if (!rows?.length) return <div className="chart-empty">No data yet.</div>;
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
});

function formatHoldTime(ms) {
  if (ms == null) return '—';
  const hours = Math.round(ms / 3600000);
  if (hours < 1) return `${Math.max(1, Math.round(ms / 60000))}m`;
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
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

    let cancelled = false;
    Promise.all([analyticsApi.getSummary(), analyticsApi.getTimeseries()])
      .then(([summaryRes, tsRes]) => {
        if (cancelled) return;
        setSummary(summaryRes.data);
        setTimeseries(tsRes.data);
      })
      .catch(err => {
        if (!cancelled) setError(err.response?.data?.message || 'Failed to load analytics.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [tierLimits.performanceDashboard]);

  const equityPoints = useMemo(
    () => timeseries?.equityCurve || summary?.equityCurve || [],
    [timeseries, summary]
  );

  const strategyRows = useMemo(() => {
    const fromSummary = summary?.byStrategy || [];
    if (fromSummary.length) return fromSummary;
    return (summary?.patternStats || timeseries?.patternStats || []).map(row => ({
      ...row,
      label: row.label || row.pattern || row.key
    }));
  }, [summary, timeseries]);

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
        <h3>Signal Performance</h3>
        <p>Win rate, R multiples, and breakdowns for TradingView webhook signals</p>
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
          <span>Avg R</span>
          <strong>{summary.avgR}R</strong>
        </div>
        <div className="analytics-stat">
          <span>Avg hold time</span>
          <strong>{formatHoldTime(summary.avgHoldTimeMs)}</strong>
        </div>
      </div>

      <div className="analytics-panels">
        <div className="analytics-panel">
          <h4>Equity curve (R multiples)</h4>
          <EquityChart points={equityPoints} />
        </div>

        <div className="analytics-panel">
          <h4>Success by day</h4>
          <BarChart
            rows={summary.successByDay || timeseries?.timeseries || []}
            valueKey="wins"
            labelKey="date"
          />
        </div>

        <div className="analytics-panel">
          <h4>By strategy</h4>
          <BarChart rows={strategyRows} valueKey="winRate" labelKey="label" />
        </div>

        <div className="analytics-panel">
          <h4>By pair</h4>
          <BarChart rows={summary.byPair || []} valueKey="winRate" labelKey="label" />
        </div>

        <div className="analytics-panel">
          <h4>By timeframe</h4>
          <BarChart rows={summary.byTimeframe || []} valueKey="winRate" labelKey="label" />
        </div>

        <div className="analytics-panel">
          <h4>By session (UTC)</h4>
          <BarChart rows={summary.bySession || []} valueKey="winRate" labelKey="label" />
        </div>

        <div className="analytics-panel">
          <h4>Confidence vs win rate</h4>
          <BarChart rows={summary.confidenceVsWinRate || []} valueKey="winRate" labelKey="bucket" />
        </div>

        <div className="analytics-panel analytics-panel--table">
          <h4>Strategy performance</h4>
          {strategyRows.length === 0 ? (
            <div className="chart-empty">No closed strategy trades yet.</div>
          ) : (
            <div className="pattern-stats-table insights-stats-table">
              <table>
                <thead>
                  <tr>
                    <th>Strategy</th>
                    <th>Trades</th>
                    <th>Win rate</th>
                    <th>Avg R</th>
                  </tr>
                </thead>
                <tbody>
                  {strategyRows.map(row => (
                    <tr key={row.key || row.pattern || row.label}>
                      <td data-label="Strategy">{row.label || row.pattern}</td>
                      <td data-label="Trades">{row.total}</td>
                      <td data-label="Win rate">{row.winRate}%</td>
                      <td data-label="Avg R">{row.avgR}R</td>
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
