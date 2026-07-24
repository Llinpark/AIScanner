const P = require('../services/PineScriptGeneratorService');
const g = P.generateForUser({
  _id: '507f1f77bcf86cd799439011',
  email: 't@test.com',
  subscription: { tier: 'professional', status: 'active' }
});

console.log(
  JSON.stringify(
    {
      webhookUrl: g.webhookUrl,
      hasCandleFeed: g.script.includes('SEND_CANDLE_FEED'),
      hasServerScanner: g.script.includes('server scanner'),
      hasStrategyName: g.script.includes('strategyName'),
      instructions: g.instructions,
      samplePayload: g.samplePayload
    },
    null,
    2
  )
);
