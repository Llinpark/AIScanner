import {
  CHART_TIMEFRAME_OPTIONS,
  isChartTimeframeAllowed
} from '../../constants/chartTimeframes';
import { getUpgradeLabelForTimeframe } from '../../constants/subscriptionLimits';
import { normalizeInterval } from '../../utils/chartLevels';

export default function ChartTimeframeToolbar({
  symbol,
  allowedSymbols = [],
  onSymbolChange,
  activeInterval,
  allowedTimeframes = ['1h'],
  onTimeframeChange,
  loading = false
}) {
  const showSymbolSelect = allowedSymbols.length > 1 && onSymbolChange;

  return (
    <div className="chart-timeframe-toolbar">
      <div className="chart-toolbar-symbol">
        {showSymbolSelect ? (
          <select
            className="chart-toolbar-symbol-select"
            value={symbol}
            onChange={event => onSymbolChange(event.target.value)}
            aria-label="Chart symbol"
          >
            {allowedSymbols.map(pair => (
              <option key={pair} value={pair}>
                {pair}
              </option>
            ))}
          </select>
        ) : (
          <strong className="chart-toolbar-symbol-label">{symbol}</strong>
        )}
      </div>

      <div className="chart-toolbar-timeframes" role="toolbar" aria-label="Chart timeframes">
        {CHART_TIMEFRAME_OPTIONS.map(option => {
          const allowed = isChartTimeframeAllowed(option.apiInterval, allowedTimeframes);
          const active =
            normalizeInterval(activeInterval) === normalizeInterval(option.apiInterval);

          return (
            <button
              key={option.label}
              type="button"
              className={`chart-tf-btn${active ? ' active' : ''}${!allowed ? ' locked' : ''}`}
              disabled={!allowed || loading}
              onClick={() => onTimeframeChange(option.apiInterval)}
              title={!allowed ? `Included in ${getUpgradeLabelForTimeframe(option.apiInterval)}` : undefined}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
