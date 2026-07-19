import { ColorType, CrosshairMode, LineStyle } from 'lightweight-charts';

/**
 * Visual theme aligned with TradingView's default dark chart appearance.
 * Used by Lightweight Charts (not the embedded TradingView widget).
 */
export const TRADINGVIEW_CHART_THEME = {
  background: '#131722',
  surface: '#1e222d',
  surfaceRaised: '#2a2e39',
  border: '#363a45',
  borderStrong: '#485c7b',
  text: '#d1d4dc',
  textMuted: '#787b86',
  textBright: '#f0f3fa',
  grid: '#363a45',
  crosshair: '#758696',
  crosshairLabel: '#363a45',
  accent: '#2962ff',
  bullish: '#26a69a',
  bearish: '#ef5350',
  fontFamily: "-apple-system, BlinkMacSystemFont, 'Trebuchet MS', 'Segoe UI', Roboto, Ubuntu, sans-serif",
  fontSize: 12
};

export function getTradingViewChartOptions(height, scaleOptions) {
  const theme = TRADINGVIEW_CHART_THEME;

  return {
    height,
    layout: {
      background: { type: ColorType.Solid, color: theme.background },
      textColor: theme.text,
      fontFamily: theme.fontFamily,
      fontSize: theme.fontSize
    },
    grid: {
      vertLines: { color: theme.grid },
      horzLines: { color: theme.grid }
    },
    crosshair: {
      mode: CrosshairMode.Normal,
      vertLine: {
        color: theme.crosshair,
        width: 1,
        style: LineStyle.LargeDashed,
        labelBackgroundColor: theme.crosshairLabel
      },
      horzLine: {
        color: theme.crosshair,
        width: 1,
        style: LineStyle.LargeDashed,
        labelBackgroundColor: theme.crosshairLabel
      }
    },
    timeScale: {
      borderColor: theme.border,
      timeVisible: true,
      secondsVisible: scaleOptions.secondsVisible,
      barSpacing: scaleOptions.barSpacing,
      minBarSpacing: scaleOptions.minBarSpacing,
      rightOffset: 8
    },
    rightPriceScale: {
      borderColor: theme.border,
      textColor: theme.textMuted,
      autoScale: true,
      scaleMargins: { top: 0.08, bottom: 0.08 }
    }
  };
}

export function getTradingViewCandlestickOptions() {
  const theme = TRADINGVIEW_CHART_THEME;

  return {
    upColor: theme.bullish,
    downColor: theme.bearish,
    borderVisible: true,
    borderUpColor: theme.bullish,
    borderDownColor: theme.bearish,
    wickUpColor: theme.bullish,
    wickDownColor: theme.bearish,
    priceLineVisible: true,
    lastValueVisible: true,
    priceLineWidth: 1,
    priceLineStyle: LineStyle.Dashed,
    crosshairMarkerVisible: true,
    crosshairMarkerRadius: 4
  };
}
