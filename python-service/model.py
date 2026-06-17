import numpy as np
import pandas as pd
from pydantic import BaseModel
from datetime import datetime

class LSTMSignalModel:
    def __init__(self):
        self.is_trained = False

    def predict(self, features: pd.DataFrame) -> float:
        if not self.is_trained:
            return 0.5
        return float(np.mean(features[-5:]['close'].pct_change().fillna(0)) * 100)


def detect_breakaway_gap(bars: pd.DataFrame) -> bool:
    if len(bars) < 4:
        return False
    prev3, prev2, prev1, current = bars.iloc[-4], bars.iloc[-3], bars.iloc[-2], bars.iloc[-1]
    return current['open'] > prev1['high'] and current['close'] > current['open']


def detect_perfect_fvg(bars: pd.DataFrame) -> bool:
    if len(bars) < 3:
        return False
    last = bars.iloc[-1]
    prior = bars.iloc[-2]
    gap = abs(last['close'] - prior['close'])
    return gap / prior['close'] > 0.01


def generate_signals(symbol: str, bars: pd.DataFrame, model: LSTMSignalModel):
    price = float(bars.iloc[-1]['close'])
    direction = 'neutral'
    note = 'No clear signal detected.'

    recent = bars.tail(10)
    if detect_breakaway_gap(bars):
        direction = 'long'
        note = 'Breakaway gap detected on third candle close.'
    elif detect_perfect_fvg(bars):
        direction = 'long'
        note = 'Perfect FVG found.'

    score = model.predict(bars)
    if score > 0.5:
        direction = 'long'
    elif score < -0.5:
        direction = 'short'

    entry = price
    stop_loss = price * 0.995 if direction == 'long' else price * 1.005
    take_profit_1 = price * 1.01 if direction == 'long' else price * 0.99
    take_profit_2 = price * 1.02 if direction == 'long' else price * 0.98
    take_profit_3 = price * 1.035 if direction == 'long' else price * 0.965

    return {
        'symbol': symbol,
        'timestamp': datetime.utcnow(),
        'direction': direction,
        'entry': entry,
        'stop_loss': stop_loss,
        'take_profit_1': take_profit_1,
        'take_profit_2': take_profit_2,
        'take_profit_3': take_profit_3,
        'confidence': float(min(max(abs(score) / 10, 0.1), 0.99)),
        'notes': note
    }
