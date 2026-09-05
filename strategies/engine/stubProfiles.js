/**
 * Future Strategy Profile stubs — registered disabled so Admin can list them.
 * Implementing one: replace stub with a live profile + createInstance; no Scanner Engine changes.
 */

const { createStubProfile } = require('./createStubStrategy');

function createStubProfiles() {
  return [
    createStubProfile({
      id: 'swing_trading',
      key: 'swing',
      name: 'Swing Strategy',
      description: 'Multi-day swing setups — coming soon.',
      priority: 30,
      entryTimeframes: ['1h', '4h'],
      higherTimeframes: ['4h', '1d'],
      defaultEntryTimeframe: '1h',
      dataRequirements: {
        htfContextKey: 'htfCandles',
        fallbackHtfKeys: [],
        defaultTimeframe: '1h'
      }
    }),
    createStubProfile({
      id: 'london_open',
      key: 'london_open',
      name: 'London Open Strategy',
      description: 'London session open liquidity / breakout — coming soon.',
      priority: 40,
      entryTimeframes: ['5m', '15m'],
      higherTimeframes: ['1h', '4h'],
      defaultEntryTimeframe: '15m'
    }),
    createStubProfile({
      id: 'new_york_reversal',
      key: 'ny_reversal',
      name: 'New York Reversal Strategy',
      description: 'NY session reversal / Judas swing — coming soon.',
      priority: 50,
      entryTimeframes: ['5m', '15m'],
      higherTimeframes: ['1h', '4h'],
      defaultEntryTimeframe: '15m'
    }),
    createStubProfile({
      id: 'asian_session',
      key: 'asian_session',
      name: 'Asian Session Strategy',
      description: 'Asian range / session levels — coming soon.',
      priority: 60,
      entryTimeframes: ['5m', '15m'],
      higherTimeframes: ['1h'],
      defaultEntryTimeframe: '15m'
    }),
    createStubProfile({
      id: 'trend_continuation',
      key: 'trend_continuation',
      name: 'Trend Continuation Strategy',
      description: 'Pullback continuation in HTF trend — coming soon.',
      priority: 70,
      entryTimeframes: ['15m', '1h'],
      higherTimeframes: ['4h', '1d'],
      defaultEntryTimeframe: '15m'
    })
  ];
}

module.exports = { createStubProfiles };
