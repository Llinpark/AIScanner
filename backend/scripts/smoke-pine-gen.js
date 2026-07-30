const P = require('../services/PineScriptGeneratorService');
const g = P.generateForUser({
  _id: '507f1f77bcf86cd799439011',
  email: 't@test.com',
  tradingviewUsername: 'demo_trader',
  subscription: { tier: 'professional', status: 'active' }
});

console.log(
  JSON.stringify(
    {
      webhookUrl: g.webhookUrl,
      tradingviewUsername: g.tradingviewUsername,
      hasLicenseConfirm: g.script.includes('CONFIRM_TV_USERNAME'),
      hasLicensedConst: g.script.includes('LICENSED_TV_USERNAME'),
      hasLicenseGate: g.script.includes('licenseOk and'),
      hasCandleFeed: g.script.includes('SEND_CANDLE_FEED'),
      hasServerScanner: g.script.includes('server scanner'),
      hasStrategyName: g.script.includes('strategyName'),
      instructions: g.instructions,
      samplePayload: g.samplePayload,
      security: g.security
    },
    null,
    2
  )
);
