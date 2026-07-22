import { useEffect, useMemo, useRef, useState } from 'react';
import {
  BaselineSeries,
  CandlestickSeries,
  createChart,
  createSeriesMarkers,
  HistogramSeries,
  LineStyle
} from 'lightweight-charts';
import {
  buildChartOverlay,
  normalizeCandles,
  normalizeInterval
} from '../../utils/chartLevels';
import { timeframeLabel } from '../../constants/chartTimeframes';
import {
  CHART_RANGE_PRESETS,
  getTradingViewCandlestickOptions,
  getTradingViewChartOptions,
  getTradingViewVolumeScaleOptions,
  getTradingViewVolumeSeriesOptions,
  TRADINGVIEW_CHART_THEME
} from '../../constants/tradingViewChartTheme';
import {
  formatInstrumentPrice,
  getChartPriceFormat
} from '../../utils/pricePrecision';
import { formatMarketDataProvider } from '../../utils/marketDataProviders';

function getChartScaleOptions(interval) {
  const canonical = normalizeInterval(interval);
  const presets = {
    '1m': { visibleBars: 100, barSpacing: 12, minBarSpacing: 5, secondsVisible: true },
    '5m': { visibleBars: 84, barSpacing: 13, minBarSpacing: 5, secondsVisible: true },
    '15m': { visibleBars: 72, barSpacing: 14, minBarSpacing: 6, secondsVisible: false },
    '30m': { visibleBars: 64, barSpacing: 15, minBarSpacing: 6, secondsVisible: false },
    '1h': { visibleBars: 56, barSpacing: 16, minBarSpacing: 7, secondsVisible: false },
    '4h': { visibleBars: 48, barSpacing: 17, minBarSpacing: 7, secondsVisible: false },
    '1d': { visibleBars: 42, barSpacing: 18, minBarSpacing: 8, secondsVisible: false },
    '1w': { visibleBars: 36, barSpacing: 18, minBarSpacing: 8, secondsVisible: false },
    '1M': { visibleBars: 28, barSpacing: 20, minBarSpacing: 8, secondsVisible: false }
  };

  return presets[canonical] || presets['1h'];
}

function applyDefaultChartView(chart, barCount, interval = '1h') {
  if (!chart) return;
  const scale = getChartScaleOptions(interval);
  chart.timeScale().applyOptions({
    barSpacing: scale.barSpacing,
    minBarSpacing: scale.minBarSpacing,
    secondsVisible: scale.secondsVisible,
    timeVisible: true
  });
  if (barCount > 1) {
    chart.timeScale().setVisibleLogicalRange({
      from: Math.max(0, barCount - scale.visibleBars),
      to: barCount + 0.5
    });
  } else {
    chart.timeScale().fitContent();
  }
}

function applyRangePreset(chart, candles, presetId) {
  if (!chart || !candles.length) return;
  const preset = CHART_RANGE_PRESETS.find(item => item.id === presetId);
  if (!preset || preset.seconds == null) {
    chart.timeScale().fitContent();
    return;
  }

  const lastTime = candles[candles.length - 1].time;
  const firstTime = candles[0].time;
  const from = Math.max(firstTime, lastTime - preset.seconds);
  try {
    chart.timeScale().setVisibleRange({ from, to: lastTime });
  } catch {
    chart.timeScale().fitContent();
  }
}

function toCandleSeriesData(rows) {
  return rows.map(({ time, open, high, low, close }) => ({ time, open, high, low, close }));
}

function toVolumeSeriesData(rows) {
  const theme = TRADINGVIEW_CHART_THEME;
  return rows.map(candle => ({
    time: candle.time,
    value: candle.volume || 0,
    color: candle.close >= candle.open ? theme.volumeBullish : theme.volumeBearish
  }));
}

function toVolumePoint(candle) {
  if (!candle) return null;
  const theme = TRADINGVIEW_CHART_THEME;
  return {
    time: candle.time,
    value: candle.volume || 0,
    color: candle.close >= candle.open ? theme.volumeBullish : theme.volumeBearish
  };
}

function formatVolume(value) {
  if (!Number.isFinite(value) || value <= 0) return '—';
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(2)}K`;
  return String(Math.round(value));
}

function buildOhlcLegend(candles, index, symbol) {
  if (!candles.length || index < 0 || index >= candles.length) return null;
  const candle = candles[index];
  const prev = index > 0 ? candles[index - 1] : null;
  const changeBase = prev ? prev.close : candle.open;
  const change = candle.close - changeBase;
  const changePct = changeBase !== 0 ? (change / changeBase) * 100 : 0;
  const bullish = candle.close >= candle.open;

  return {
    symbol,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume || 0,
    change,
    changePct,
    bullish
  };
}

const LEVEL_COLORS = {
  entry: '#38bdf8',
  sl: '#f87171',
  tp1: '#34d399',
  tp2: '#10b981',
  tp3: '#059669',
  fvg: 'rgba(139, 92, 246, 0.32)',
  fvgLine: 'rgba(167, 139, 250, 0.9)',
  orderBlock: 'rgba(245, 158, 11, 0.28)',
  orderBlockLine: 'rgba(251, 191, 36, 0.95)',
  liquidity: 'rgba(56, 189, 248, 0.22)',
  liquidityLine: 'rgba(125, 211, 252, 0.95)'
};

function applyTradeLevels(series, overlay, priceLinesRef) {
  if (!series || !overlay) return;

  const lines = [
    { price: overlay.entry, color: LEVEL_COLORS.entry, title: 'Kaching Entry', style: LineStyle.Solid },
    { price: overlay.stopLoss, color: LEVEL_COLORS.sl, title: 'Kaching SL', style: LineStyle.Solid },
    { price: overlay.tp1, color: LEVEL_COLORS.tp1, title: 'Kaching TP1', style: LineStyle.Solid },
    { price: overlay.tp2, color: LEVEL_COLORS.tp2, title: 'Kaching TP2', style: LineStyle.Solid },
    { price: overlay.tp3, color: LEVEL_COLORS.tp3, title: 'Kaching TP3', style: LineStyle.Solid }
  ];

  lines.forEach(line => {
    if (!Number.isFinite(line.price)) return;
    priceLinesRef.current.push(
      series.createPriceLine({
        price: line.price,
        color: line.color,
        lineWidth: 2,
        lineStyle: line.style,
        axisLabelVisible: true,
        title: line.title
      })
    );
  });
}

function applyZoneBoundaryLines(series, zone, color, topLabel, bottomLabel, priceLinesRef) {
  if (!series || !zone) return;
  if (!Number.isFinite(zone.top) || !Number.isFinite(zone.bottom)) return;

  priceLinesRef.current.push(
    series.createPriceLine({
      price: zone.top,
      color,
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: topLabel
    })
  );
  priceLinesRef.current.push(
    series.createPriceLine({
      price: zone.bottom,
      color,
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: bottomLabel
    })
  );
}

function createZoneSeries(chart, zone, options) {
  if (!chart || !zone) return null;
  if (!Number.isFinite(zone.top) || !Number.isFinite(zone.bottom)) return null;
  if (!zone.chartTimeStart || !zone.chartTimeEnd) return null;

  const top = Math.max(zone.top, zone.bottom);
  const bottom = Math.min(zone.top, zone.bottom);

  const series = chart.addSeries(BaselineSeries, {
    baseValue: { type: 'price', price: bottom },
    topFillColor1: options.fillColor,
    topFillColor2: options.fillColor,
    bottomFillColor1: 'rgba(0, 0, 0, 0)',
    bottomFillColor2: 'rgba(0, 0, 0, 0)',
    lineColor: options.lineColor,
    lineWidth: 1,
    lineStyle: LineStyle.Solid,
    priceLineVisible: false,
    lastValueVisible: false,
    crosshairMarkerVisible: false
  });

  series.setData([
    { time: zone.chartTimeStart, value: top },
    { time: zone.chartTimeEnd, value: top }
  ]);

  return series;
}

function lastCandleColor(candles) {
  if (!candles.length) return TRADINGVIEW_CHART_THEME.accent;
  const last = candles[candles.length - 1];
  return last.close >= last.open ? TRADINGVIEW_CHART_THEME.bullish : TRADINGVIEW_CHART_THEME.bearish;
}

function getTradeSide(overlay) {
  const direction = String(overlay?.direction || '').toLowerCase();
  const isLong = direction === 'long' || direction === 'buy';
  return {
    isLong,
    label: isLong ? 'Buy' : 'Sell',
    color: isLong ? TRADINGVIEW_CHART_THEME.bullish : TRADINGVIEW_CHART_THEME.bearish
  };
}

function buildMarkers(candles, overlay) {
  if (!overlay || !candles.length) return [];
  const last = candles[candles.length - 1];
  const { isLong, label, color } = getTradeSide(overlay);
  const position = isLong ? 'belowBar' : 'aboveBar';
  const markers = [
    {
      time: last.time,
      position,
      color,
      shape: 'circle',
      text: ''
    },
    {
      time: last.time,
      position,
      color,
      shape: isLong ? 'arrowUp' : 'arrowDown',
      text: label
    }
  ];

  if (overlay.patternLabel || overlay.pattern) {
    markers.push({
      time: last.time,
      position: 'aboveBar',
      color: '#a78bfa',
      shape: 'circle',
      text: overlay.patternLabel || overlay.pattern
    });
  }

  return markers;
}

export default function KachingLightweightChart({
  candles = [],
  overlaySignal = null,
  symbol,
  interval = '1h',
  liveEnabled = true,
  liveStatus = 'idle',
  provider = null,
  height = 600
}) {
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef(null);
  const volumeSeriesRef = useRef(null);
  const markersRef = useRef(null);
  const zoneSeriesRef = useRef([]);
  const priceLinesRef = useRef([]);
  const candlesRef = useRef([]);
  const symbolRef = useRef(symbol);
  const viewKeyRef = useRef('');
  const resetViewRef = useRef(() => {});
  const applyRangeRef = useRef(() => {});
  const [chartReady, setChartReady] = useState(false);
  const [activeRange, setActiveRange] = useState(null);
  const [ohlcLegend, setOhlcLegend] = useState(null);

  symbolRef.current = symbol;

  const overlay = useMemo(
    () => buildChartOverlay(overlaySignal, candles, interval),
    [overlaySignal, candles, interval]
  );

  useEffect(() => {
    if (!containerRef.current) return undefined;

    const scaleOptions = getChartScaleOptions(interval);
    const chart = createChart(containerRef.current, {
      ...getTradingViewChartOptions(height, scaleOptions),
      handleScroll: {
        mouseWheel: false,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: false
      },
      handleScale: {
        mouseWheel: true,
        pinch: true,
        axisPressedMouseMove: {
          time: true,
          price: true
        },
        axisDoubleClickReset: {
          time: true,
          price: true
        }
      },
      kineticScroll: {
        mouse: true,
        touch: true
      }
    });

    const series = chart.addSeries(CandlestickSeries, getTradingViewCandlestickOptions());
    const volumeSeries = chart.addSeries(HistogramSeries, getTradingViewVolumeSeriesOptions());
    chart.priceScale('volume').applyOptions(getTradingViewVolumeScaleOptions());
    const seriesMarkers = createSeriesMarkers(series, []);

    chartRef.current = chart;
    seriesRef.current = series;
    volumeSeriesRef.current = volumeSeries;
    markersRef.current = seriesMarkers;
    setChartReady(true);

    const handleDoubleClick = () => {
      setActiveRange(null);
      applyDefaultChartView(chart, candlesRef.current.length, interval);
    };

    const handleCrosshairMove = param => {
      const rows = candlesRef.current;
      if (!rows.length) {
        setOhlcLegend(null);
        return;
      }

      let index = rows.length - 1;
      if (param?.time != null) {
        const time = typeof param.time === 'number' ? param.time : null;
        if (time != null) {
          const found = rows.findIndex(row => row.time === time);
          if (found >= 0) index = found;
        } else if (param.logical != null) {
          const logical = Math.round(param.logical);
          if (logical >= 0 && logical < rows.length) index = logical;
        }
      }

      setOhlcLegend(buildOhlcLegend(rows, index, symbolRef.current));
    };

    chart.subscribeDblClick(handleDoubleClick);
    chart.subscribeCrosshairMove(handleCrosshairMove);

    const resizeObserver = new ResizeObserver(entries => {
      const entry = entries[0];
      if (!entry) return;
      chart.applyOptions({ width: entry.contentRect.width });
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      chart.unsubscribeDblClick(handleDoubleClick);
      chart.unsubscribeCrosshairMove(handleCrosshairMove);
      resizeObserver.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      volumeSeriesRef.current = null;
      markersRef.current = null;
      zoneSeriesRef.current = [];
      setChartReady(false);
      setOhlcLegend(null);
    };
  }, [height, interval]);

  useEffect(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!chart || !series || !symbol) return;

    const priceFormat = getChartPriceFormat(symbol);
    series.applyOptions({ priceFormat });
    chart.applyOptions({
      localization: {
        priceFormatter: price => formatInstrumentPrice(price, symbol)
      }
    });
  }, [symbol]);

  useEffect(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    const volumeSeries = volumeSeriesRef.current;
    const seriesMarkers = markersRef.current;
    if (!chartReady || !series || !chart) return;

    const normalized = normalizeCandles(candles);
    const prev = candlesRef.current;
    const currentViewKey = `${symbol}:${interval}`;
    const shouldResetView = viewKeyRef.current !== currentViewKey;
    if (shouldResetView) {
      viewKeyRef.current = currentViewKey;
      setActiveRange(null);
    }

    const applyLivePriceLine = rows => {
      if (!rows.length) return;
      const currentPriceColor = lastCandleColor(rows);
      series.applyOptions({
        priceLineVisible: true,
        lastValueVisible: true,
        priceLineColor: currentPriceColor,
        priceLineStyle: LineStyle.Dashed,
        crosshairMarkerVisible: true,
        crosshairMarkerBorderColor: currentPriceColor,
        crosshairMarkerBackgroundColor: currentPriceColor
      });
    };

    const sameBar = (left, right) =>
      left &&
      right &&
      left.time === right.time &&
      left.open === right.open &&
      left.high === right.high &&
      left.low === right.low &&
      left.close === right.close &&
      (left.volume || 0) === (right.volume || 0);

    const syncLegend = rows => {
      if (!rows.length) {
        setOhlcLegend(null);
        return;
      }
      setOhlcLegend(buildOhlcLegend(rows, rows.length - 1, symbol));
    };

    if (!normalized.length) {
      candlesRef.current = [];
      series.setData([]);
      volumeSeries?.setData([]);
      setOhlcLegend(null);
      return;
    }

    const canIncrementalUpdate = prev.length > 0 && !shouldResetView;
    if (canIncrementalUpdate) {
      const prevLast = prev[prev.length - 1];
      const nextLast = normalized[normalized.length - 1];

      if (normalized.length === prev.length && nextLast.time === prevLast.time && !sameBar(nextLast, prevLast)) {
        series.update(toCandleSeriesData([nextLast])[0]);
        const volumePoint = toVolumePoint(nextLast);
        if (volumePoint) volumeSeries?.update(volumePoint);
        candlesRef.current = normalized;
        applyLivePriceLine(normalized);
        syncLegend(normalized);
        return;
      }

      if (
        normalized.length === prev.length + 1 &&
        sameBar(normalized[prev.length - 1], prevLast) &&
        nextLast.time !== prevLast.time
      ) {
        series.update(toCandleSeriesData([nextLast])[0]);
        const volumePoint = toVolumePoint(nextLast);
        if (volumePoint) volumeSeries?.update(volumePoint);
        candlesRef.current = normalized;
        applyLivePriceLine(normalized);
        syncLegend(normalized);
        return;
      }
    }

    candlesRef.current = normalized;
    series.setData(toCandleSeriesData(normalized));
    volumeSeries?.setData(toVolumeSeriesData(normalized));

    resetViewRef.current = () => {
      setActiveRange(null);
      applyDefaultChartView(chart, normalized.length, interval);
    };
    applyRangeRef.current = presetId => applyRangePreset(chart, normalized, presetId);

    applyLivePriceLine(normalized);
    syncLegend(normalized);

    priceLinesRef.current.forEach(line => {
      try {
        series.removePriceLine(line);
      } catch {
        // ignore stale line handles
      }
    });
    priceLinesRef.current = [];

    zoneSeriesRef.current.forEach(zoneSeries => {
      try {
        chart.removeSeries(zoneSeries);
      } catch {
        // ignore stale zone series
      }
    });
    zoneSeriesRef.current = [];

    if (overlay) {
      const zones = overlay.zones || {};

      if (zones.fvg) {
        const fvgSeries = createZoneSeries(chart, zones.fvg, {
          fillColor: LEVEL_COLORS.fvg,
          lineColor: LEVEL_COLORS.fvgLine
        });
        if (fvgSeries) zoneSeriesRef.current.push(fvgSeries);
        applyZoneBoundaryLines(
          series,
          zones.fvg,
          LEVEL_COLORS.fvgLine,
          'FVG Top',
          'FVG Bottom',
          priceLinesRef
        );
      }

      if (zones.orderBlock) {
        const obSeries = createZoneSeries(chart, zones.orderBlock, {
          fillColor: LEVEL_COLORS.orderBlock,
          lineColor: LEVEL_COLORS.orderBlockLine
        });
        if (obSeries) zoneSeriesRef.current.push(obSeries);
        applyZoneBoundaryLines(
          series,
          zones.orderBlock,
          LEVEL_COLORS.orderBlockLine,
          'Order Block Top',
          'Order Block Bottom',
          priceLinesRef
        );
      }

      if (zones.liquidity) {
        const liqSeries = createZoneSeries(chart, zones.liquidity, {
          fillColor: LEVEL_COLORS.liquidity,
          lineColor: LEVEL_COLORS.liquidityLine
        });
        if (liqSeries) zoneSeriesRef.current.push(liqSeries);
        applyZoneBoundaryLines(
          series,
          zones.liquidity,
          LEVEL_COLORS.liquidityLine,
          'Liquidity Top',
          'Liquidity Bottom',
          priceLinesRef
        );
      }

      applyTradeLevels(series, overlay, priceLinesRef);
      seriesMarkers?.setMarkers(buildMarkers(normalized, overlay));
    } else {
      seriesMarkers?.setMarkers([]);
    }

    if (shouldResetView) {
      applyDefaultChartView(chart, normalized.length, interval);
    }
  }, [candles, overlay, symbol, interval, chartReady]);

  const handleResetView = () => resetViewRef.current();

  const handleRangePreset = presetId => {
    setActiveRange(presetId);
    applyRangeRef.current(presetId);
  };

  const displayLiveStatus = liveEnabled ? liveStatus : 'off';
  const providerLabel = formatMarketDataProvider(provider);
  const formatLevel = value => formatInstrumentPrice(value, symbol);
  const changeColor = ohlcLegend?.bullish
    ? TRADINGVIEW_CHART_THEME.bullish
    : TRADINGVIEW_CHART_THEME.bearish;

  return (
    <div className="kaching-chart-wrap">
      <div className="kaching-chart-meta">
        <span>
          <strong>{symbol}</strong> · {timeframeLabel(interval)}
          {providerLabel ? ` · ${providerLabel}` : ''}
        </span>
        <span className="kaching-chart-controls">
          <button type="button" className="chart-reset-btn" onClick={handleResetView} title="Reset zoom and pan">
            Reset view
          </button>
          <span className={`kaching-chart-live live-${displayLiveStatus}`}>
            Live: {displayLiveStatus}
          </span>
        </span>
      </div>
      <div className="kaching-chart-stage">
        {ohlcLegend && (
          <div className="kaching-chart-ohlc" aria-live="polite">
            <span className="ohlc-symbol">{ohlcLegend.symbol}</span>
            <span>
              O <strong>{formatInstrumentPrice(ohlcLegend.open, symbol)}</strong>
            </span>
            <span>
              H <strong>{formatInstrumentPrice(ohlcLegend.high, symbol)}</strong>
            </span>
            <span>
              L <strong>{formatInstrumentPrice(ohlcLegend.low, symbol)}</strong>
            </span>
            <span>
              C <strong style={{ color: changeColor }}>{formatInstrumentPrice(ohlcLegend.close, symbol)}</strong>
            </span>
            <span style={{ color: changeColor }}>
              {ohlcLegend.change >= 0 ? '+' : ''}
              {formatInstrumentPrice(ohlcLegend.change, symbol)} ({ohlcLegend.changePct >= 0 ? '+' : ''}
              {ohlcLegend.changePct.toFixed(2)}%)
            </span>
            <span>
              Vol <strong>{formatVolume(ohlcLegend.volume)}</strong>
            </span>
          </div>
        )}
        <div ref={containerRef} className="kaching-chart-container" />
      </div>
      {overlay && (
        <div className="kaching-chart-legend">
          <span style={{ color: LEVEL_COLORS.entry }}>Entry {formatLevel(overlay.entry)}</span>
          <span style={{ color: LEVEL_COLORS.sl }}>SL {formatLevel(overlay.stopLoss)}</span>
          <span style={{ color: LEVEL_COLORS.tp1 }}>TP1 {formatLevel(overlay.tp1)}</span>
          <span style={{ color: LEVEL_COLORS.tp2 }}>TP2 {formatLevel(overlay.tp2)}</span>
          <span style={{ color: LEVEL_COLORS.tp3 }}>TP3 {formatLevel(overlay.tp3)}</span>
          {overlay.zones?.fvg && <span className="pattern-tag fvg-tag">Fair Value Gap</span>}
          {overlay.zones?.orderBlock && <span className="pattern-tag ob-tag">Order Block</span>}
          {overlay.zones?.liquidity && <span className="pattern-tag liq-tag">Liquidity Zone</span>}
          {(overlay.patternLabel || overlay.pattern) && (
            <span className="pattern-tag">{overlay.patternLabel || overlay.pattern}</span>
          )}
        </div>
      )}
      <div className="kaching-chart-ranges" role="group" aria-label="Chart time range">
        {CHART_RANGE_PRESETS.map(preset => (
          <button
            key={preset.id}
            type="button"
            className={`chart-range-btn${activeRange === preset.id ? ' active' : ''}`}
            onClick={() => handleRangePreset(preset.id)}
          >
            {preset.label}
          </button>
        ))}
      </div>
    </div>
  );
}
