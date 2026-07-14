import { useEffect, useMemo, useRef, useState } from 'react';
import {
  BaselineSeries,
  CandlestickSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  CrosshairMode,
  LineStyle
} from 'lightweight-charts';
import {
  buildChartOverlay,
  intervalToSeconds,
  normalizeCandles,
  symbolsMatch,
  toChartTime
} from '../../utils/chartLevels';
import { MARKET_DATA_WS_URL } from '../../config/appUrls';

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

function buildMarkers(candles, overlay) {
  if (!overlay || !candles.length) return [];
  const last = candles[candles.length - 1];
  const isLong = overlay.direction === 'long' || overlay.direction === 'buy';
  const markers = [
    {
      time: last.time,
      position: isLong ? 'belowBar' : 'aboveBar',
      color: LEVEL_COLORS.entry,
      shape: isLong ? 'arrowUp' : 'arrowDown',
      text: 'Entry'
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
  provider = null,
  height = 420
}) {
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef(null);
  const markersRef = useRef(null);
  const zoneSeriesRef = useRef([]);
  const priceLinesRef = useRef([]);
  const candlesRef = useRef([]);
  const [liveStatus, setLiveStatus] = useState('idle');

  const overlay = useMemo(
    () => buildChartOverlay(overlaySignal, candles, interval),
    [overlaySignal, candles, interval]
  );

  useEffect(() => {
    if (!containerRef.current) return undefined;

    const chart = createChart(containerRef.current, {
      height,
      layout: {
        background: { type: ColorType.Solid, color: '#0f172a' },
        textColor: '#cbd5e1'
      },
      grid: {
        vertLines: { color: 'rgba(148, 163, 184, 0.12)' },
        horzLines: { color: 'rgba(148, 163, 184, 0.12)' }
      },
      crosshair: { mode: CrosshairMode.Normal },
      timeScale: {
        borderColor: 'rgba(148, 163, 184, 0.25)',
        timeVisible: true,
        secondsVisible: false
      },
      rightPriceScale: {
        borderColor: 'rgba(148, 163, 184, 0.25)'
      }
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor: '#22c55e',
      downColor: '#ef4444',
      borderVisible: false,
      wickUpColor: '#22c55e',
      wickDownColor: '#ef4444'
    });
    const seriesMarkers = createSeriesMarkers(series, []);

    chartRef.current = chart;
    seriesRef.current = series;
    markersRef.current = seriesMarkers;

    const resizeObserver = new ResizeObserver(entries => {
      const entry = entries[0];
      if (!entry) return;
      chart.applyOptions({ width: entry.contentRect.width });
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      markersRef.current = null;
      zoneSeriesRef.current = [];
    };
  }, [height]);

  useEffect(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    const seriesMarkers = markersRef.current;
    if (!series || !chart) return;

    const normalized = normalizeCandles(candles);
    candlesRef.current = normalized;
    series.setData(normalized);

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

    chart.timeScale().fitContent();
  }, [candles, overlay]);

  useEffect(() => {
    if (!liveEnabled || !symbol || !MARKET_DATA_WS_URL) {
      setLiveStatus('off');
      return undefined;
    }

    let closed = false;
    let ws;
    setLiveStatus('connecting');

    try {
      ws = new WebSocket(`${MARKET_DATA_WS_URL}/market-data/ws`);
    } catch {
      setLiveStatus('error');
      return undefined;
    }

    ws.onopen = () => {
      if (closed) return;
      setLiveStatus('connected');
      ws.send(JSON.stringify({ action: 'subscribe', symbols: [symbol] }));
    };

    ws.onmessage = event => {
      const series = seriesRef.current;
      if (!series) return;

      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }

      if (payload.type !== 'price') return;
      if (payload.symbol && !symbolsMatch(payload.symbol, symbol)) return;

      const price = Number(payload.price);
      if (!Number.isFinite(price)) return;

      const current = candlesRef.current;
      if (!current.length) return;

      const bucketSeconds = intervalToSeconds(interval);
      const tickTime = toChartTime(payload.timestamp) || Math.floor(Date.now() / 1000);
      const last = { ...current[current.length - 1] };
      const sameBucket = tickTime - last.time < bucketSeconds;

      if (sameBucket) {
        last.close = price;
        last.high = Math.max(last.high, price);
        last.low = Math.min(last.low, price);
        current[current.length - 1] = last;
      } else {
        const nextTime = last.time + bucketSeconds;
        current.push({
          time: nextTime,
          open: price,
          high: price,
          low: price,
          close: price
        });
      }

      candlesRef.current = current;
      series.update(current[current.length - 1]);
    };

    ws.onerror = () => setLiveStatus('error');
    ws.onclose = () => {
      if (!closed) setLiveStatus('disconnected');
    };

    return () => {
      closed = true;
      ws?.close();
    };
  }, [liveEnabled, symbol, interval]);

  const formatLevel = value => (Number.isFinite(value) ? value.toFixed(5) : '—');

  return (
    <div className="kaching-chart-wrap">
      <div className="kaching-chart-meta">
        <span>
          <strong>{symbol}</strong> · {interval}
          {provider ? ` · ${provider}` : ''}
        </span>
        <span className={`kaching-chart-live live-${liveStatus}`}>
          Live: {liveStatus}
        </span>
      </div>
      <div ref={containerRef} className="kaching-chart-container" />
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
    </div>
  );
}
