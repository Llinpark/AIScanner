/* eslint-disable */
/**
 * Fly in-app runner for purge-mt5-linktoken.js
 * fly ssh console -a kaching-api -C "CONFIRM_PURGE=YES node /app/scripts/purge-mt5-linktoken.fly.js"
 */
process.chdir('/app');
require('/app/scripts/purge-mt5-linktoken.js');
