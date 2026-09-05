require('dotenv').config();
const mongoose = require('mongoose');
const Signal = require('../models/Signal');
const { buildAnalytics } = require('../utils/signalOutcome');
const {
  isWebhookInsightsSignal,
  legacySourceMongoExclusion
} = require('../utils/insightsSignalFilter');

(async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI missing');
  await mongoose.connect(uri);
  const cutoff = new Date(Date.now() - 90 * 24 * 3600 * 1000);
  const all = await Signal.find({ createdAt: { $gte: cutoff } })
    .sort({ createdAt: -1 })
    .limit(1000)
    .lean();
  const entries = all.filter(s => {
    const t = s.alertType || 'signal';
    return t === 'entry' || t === 'signal';
  });
  const openAll = entries.filter(s => !s.outcome || s.outcome === 'pending');
  const bySource = {};
  for (const s of openAll) {
    const key = [s.source || '-', s.signalSource || '-', s.origin || '-'].join(' | ');
    bySource[key] = (bySource[key] || 0) + 1;
  }
  const filtered = all.filter(isWebhookInsightsSignal);
  const analytics = buildAnalytics(filtered);
  const mongoFiltered = await Signal.find({
    createdAt: { $gte: cutoff },
    ...legacySourceMongoExclusion()
  })
    .sort({ createdAt: -1 })
    .limit(1000)
    .lean();
  const analyticsMongo = buildAnalytics(mongoFiltered.filter(isWebhookInsightsSignal));
  console.log(
    JSON.stringify(
      {
        openBeforeFilter: openAll.length,
        openSourceBreakdown: bySource,
        openAfterJsFilter: analytics.openTrades,
        closedAfterJsFilter: analytics.closedTrades,
        openAfterMongoPlusJs: analyticsMongo.openTrades,
        closedAfterMongoPlusJs: analyticsMongo.closedTrades
      },
      null,
      2
    )
  );
  await mongoose.disconnect();
})().catch(err => {
  console.error(err);
  process.exit(1);
});
