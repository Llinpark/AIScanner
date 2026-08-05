//+------------------------------------------------------------------+
//|                                         KachingTradeCopier.mq5   |
//|                        KachingScanner Telegram Trade Copier EA   |
//|                                                                  |
//| Auth (v1.14+): PairCode → device access/refresh tokens           |
//| Trade mgmt (v1.22+): EA is complete trade manager after ENTRY    |
//|  - Local TP1/TP2/TP3, partials, BE, trailing (no further TV)     |
//|  - Transactional flags (broker confirm → flags → persist → report)|
//|  - Idempotent broker ops: validate Expected vs Broker before send|
//|  - Durable event queue + ack; partial/BE retry with backoff      |
//|  - Reconciler (OnInit / reconnect / token / 60s) + Common Files  |
//|  - Auto symbol map, filling-mode detect, duplicate protection    |
//+------------------------------------------------------------------+
#property copyright "KachingScanner"
#property version   "1.22"
#property strict

//======================== Primary inputs ========================
input string PairCode            = "";     // 8-char Pair Code from dashboard (one-time)
input int    PollSeconds         = 1;      // Bridge poll interval (seconds)
input int    MagicNumber         = 88001;
input double RiskPercent         = 1.0;    // Chart display reference (lot sizing from dashboard)
input double MaxSlippagePoints   = 30;
input string SymbolSuffixOverride = "";    // Optional broker suffix override (prefer auto-map)

//======================== Partial close ========================
enum ENUM_PARTIAL_PRESET
{
   PARTIAL_CUSTOM       = 0,  // Custom percents below
   PARTIAL_CONSERVATIVE = 1,  // 25 / 25 / 50
   PARTIAL_BALANCED     = 2,  // 40 / 30 / 30 (default)
   PARTIAL_AGGRESSIVE   = 3   // 50 / 30 / 20
};

input group "=== Partial Close ==="
input bool               EnablePartialClose = true;
input ENUM_PARTIAL_PRESET PartialPreset     = PARTIAL_BALANCED;
input double             TP1_ClosePercent   = 40.0; // Must sum 100% with TP2/TP3 when Custom
input double             TP2_ClosePercent   = 30.0;
input double             TP3_ClosePercent   = 30.0;

//======================== Break-even ========================
enum ENUM_BE_MODE
{
   BE_DISABLED          = 0,
   BE_AT_TP1            = 1,
   BE_AFTER_X_PIPS      = 2,
   BE_AFTER_X_ATR       = 3,
   BE_AFTER_X_PCT_TARGET = 4
};

enum ENUM_BE_OFFSET
{
   BE_OFF_ENTRY = 0,  // Exact entry
   BE_OFF_PLUS1 = 1,  // Entry + 1 pip
   BE_OFF_PLUS2 = 2,  // Entry + 2 pips (default)
   BE_OFF_PLUS5 = 5   // Entry + 5 pips
};

input group "=== Break Even ==="
input ENUM_BE_MODE   BreakEvenMode   = BE_AT_TP1;
input double         BE_XPips        = 20.0;
input double         BE_XATR         = 1.0;
input int            BE_ATR_Period   = 14;
input double         BE_XPercentTarget = 50.0; // % of entry→TP1 distance
input ENUM_BE_OFFSET BreakEvenOffset = BE_OFF_PLUS2;

//======================== Trailing ========================
enum ENUM_TRAIL_MODE
{
   TRAIL_DISABLED         = 0,
   TRAIL_FIXED_PIPS       = 1,
   TRAIL_ATR              = 2,
   TRAIL_SWING_HL         = 3,
   TRAIL_MARKET_STRUCTURE = 4,
   TRAIL_STEP             = 5
};

enum ENUM_TRAIL_START
{
   TRAIL_START_IMMEDIATE = 0,
   TRAIL_START_AFTER_TP1 = 1,
   TRAIL_START_AFTER_TP2 = 2
};

input group "=== Trailing Stop ==="
input ENUM_TRAIL_MODE  TrailingMode      = TRAIL_FIXED_PIPS;
input ENUM_TRAIL_START TrailingStart     = TRAIL_START_AFTER_TP1;
input double           TrailFixedPips    = 20.0;
input double           TrailATRMult      = 1.5;
input int              TrailATRPeriod    = 14;
input int              TrailSwingBars    = 10;
input double           TrailStepPips     = 5.0;

#define KACHING_DEFAULT_BACKEND "https://api.kachingscanner.com"
#define KACHING_EA_VERSION "1.22"
#define CRED_FILE "KachingAI_credentials.txt"
#define MANAGED_FILE "KachingAI_managed_trades.txt"
#define EVENT_QUEUE_FILE "KachingAI_event_queue.dat"
#define HEARTBEAT_SECONDS 30
#define RECONCILE_SECONDS 60
#define MAX_MANAGED 64
#define MAX_EVENT_QUEUE 128
#define MAX_SYMBOL_CACHE 512
#define ATR_TIMEFRAME PERIOD_H1

//======================== Managed trade state ========================
struct ManagedTrade
{
   ulong  ticket;
   string executionId;
   string signalId;
   string symbol;
   bool   isBuy;
   double entry;
   double initialSl;
   double tp1;
   double tp2;
   double tp3;
   double initialVolume;
   double remainingVolume;
   double initialR;
   bool   tp1Hit;
   bool   tp2Hit;
   bool   tp3Hit;
   bool   breakEvenDone;
   bool   trailArmed;
   bool   trailReported;
   int    magic;
   string comment;
   bool   active;
   // In-memory retry (re-detected from price after restart)
   string pendingOp;       // "", "tp1", "tp2", "tp3", "be"
   int    retryCount;
   datetime nextRetryAt;
   string lastRetryNote;
};

struct QueuedEvent
{
   bool   active;
   string eventUuid;
   string executionId;
   string status;
   string eventName;
   ulong  ticket;
   double price;
   double remainingVol;
   double partialVol;
   double partialPct;
   string errorMessage;
};

ManagedTrade g_managed[MAX_MANAGED];
QueuedEvent  g_eventQueue[MAX_EVENT_QUEUE];
datetime lastPoll = 0;
datetime g_lastHeartbeat = 0;
int      g_eventSeq = 0;
bool     g_managedDirty = false;
string   g_managedSnapshot = "";

string g_backendUrl = "";
string g_token = "";
string g_refreshToken = "";
string g_deviceId = "";
string g_subscriberId = "";
string g_accessExpiresAt = "";
string g_statusLine = "Waiting for Pair Code";
string g_lastError = "";
string g_panelExtra = "";
datetime g_lastSyncAt = 0;
datetime g_lastReconcileAt = 0;
bool   g_connected = false;
bool   g_wasConnected = false;
bool   g_needsRepair = false;
double g_displayRiskPercent = 1.0;

// Broker snapshot
string g_brokerName = "";
string g_serverName = "";
long   g_accountLogin = 0;
ENUM_ACCOUNT_TRADE_MODE g_accountMode = ACCOUNT_TRADE_MODE_DEMO;
int    g_accountType = 0; // 0=hedging context hint from positions

// Symbol cache
string g_symbolCache[MAX_SYMBOL_CACHE];
int    g_symbolCacheCount = 0;
datetime g_symbolCacheBuilt = 0;

// Resolved partial percents
double g_tp1Pct = 40.0;
double g_tp2Pct = 30.0;
double g_tp3Pct = 30.0;

//+------------------------------------------------------------------+
string EffectiveBackendUrl()
{
   if(StringLen(g_backendUrl) > 0) return g_backendUrl;
   return KACHING_DEFAULT_BACKEND;
}

string MachineFingerprint()
{
   return StringFormat("%d-%I64d-%s",
      TerminalInfoInteger(TERMINAL_BUILD),
      AccountInfoInteger(ACCOUNT_LOGIN),
      AccountInfoString(ACCOUNT_SERVER));
}

void RefreshBrokerSnapshot()
{
   g_brokerName = AccountInfoString(ACCOUNT_COMPANY);
   g_serverName = AccountInfoString(ACCOUNT_SERVER);
   g_accountLogin = AccountInfoInteger(ACCOUNT_LOGIN);
   g_accountMode = (ENUM_ACCOUNT_TRADE_MODE)AccountInfoInteger(ACCOUNT_TRADE_MODE);
}

//+------------------------------------------------------------------+
//| Credentials (unchanged contract)                                  |
//+------------------------------------------------------------------+
bool SaveCredentials()
{
   int handle = FileOpen(CRED_FILE, FILE_WRITE|FILE_TXT|FILE_ANSI|FILE_COMMON);
   if(handle == INVALID_HANDLE)
   {
      Print("Failed to save credentials: ", GetLastError());
      return false;
   }
   FileWriteString(handle, "v2\n");
   FileWriteString(handle, g_backendUrl + "\n");
   FileWriteString(handle, g_token + "\n");
   FileWriteString(handle, g_refreshToken + "\n");
   FileWriteString(handle, g_deviceId + "\n");
   FileWriteString(handle, g_subscriberId + "\n");
   FileWriteString(handle, g_accessExpiresAt + "\n");
   FileClose(handle);
   return true;
}

bool LoadCredentials()
{
   if(!FileIsExist(CRED_FILE, FILE_COMMON))
      return false;

   int handle = FileOpen(CRED_FILE, FILE_READ|FILE_TXT|FILE_ANSI|FILE_COMMON);
   if(handle == INVALID_HANDLE)
      return false;

   string line1 = FileReadString(handle);
   StringTrimLeft(line1); StringTrimRight(line1);

   if(line1 == "v2")
   {
      g_backendUrl = FileReadString(handle);
      g_token = FileReadString(handle);
      g_refreshToken = FileReadString(handle);
      g_deviceId = FileReadString(handle);
      g_subscriberId = FileReadString(handle);
      if(!FileIsEnding(handle))
         g_accessExpiresAt = FileReadString(handle);
   }
   else
   {
      g_backendUrl = line1;
      g_token = FileReadString(handle);
      g_subscriberId = "";
      if(!FileIsEnding(handle))
         g_subscriberId = FileReadString(handle);
      g_refreshToken = "";
      g_deviceId = "";
      g_accessExpiresAt = "";
   }
   FileClose(handle);

   StringTrimLeft(g_backendUrl); StringTrimRight(g_backendUrl);
   StringTrimLeft(g_token); StringTrimRight(g_token);
   StringTrimLeft(g_refreshToken); StringTrimRight(g_refreshToken);
   StringTrimLeft(g_deviceId); StringTrimRight(g_deviceId);
   StringTrimLeft(g_subscriberId); StringTrimRight(g_subscriberId);
   StringTrimLeft(g_accessExpiresAt); StringTrimRight(g_accessExpiresAt);

   return (StringLen(g_backendUrl) > 0 && StringLen(g_token) > 0);
}

void ClearSavedCredentials()
{
   if(FileIsExist(CRED_FILE, FILE_COMMON))
      FileDelete(CRED_FILE, FILE_COMMON);
   g_token = "";
   g_refreshToken = "";
   g_deviceId = "";
   g_accessExpiresAt = "";
   g_connected = false;
   g_needsRepair = true;
}

//+------------------------------------------------------------------+
//| Partial percent resolution                                        |
//+------------------------------------------------------------------+
bool ResolvePartialPercents()
{
   if(PartialPreset == PARTIAL_CONSERVATIVE)
   {
      g_tp1Pct = 25.0; g_tp2Pct = 25.0; g_tp3Pct = 50.0;
   }
   else if(PartialPreset == PARTIAL_BALANCED)
   {
      g_tp1Pct = 40.0; g_tp2Pct = 30.0; g_tp3Pct = 30.0;
   }
   else if(PartialPreset == PARTIAL_AGGRESSIVE)
   {
      g_tp1Pct = 50.0; g_tp2Pct = 30.0; g_tp3Pct = 20.0;
   }
   else
   {
      g_tp1Pct = TP1_ClosePercent;
      g_tp2Pct = TP2_ClosePercent;
      g_tp3Pct = TP3_ClosePercent;
   }

   if(!EnablePartialClose)
      return true;

   double sum = g_tp1Pct + g_tp2Pct + g_tp3Pct;
   if(MathAbs(sum - 100.0) > 0.01 || g_tp1Pct < 0 || g_tp2Pct < 0 || g_tp3Pct < 0)
   {
      PrintFormat("Invalid TP close percents (%.2f+%.2f+%.2f=%.2f). Must sum to 100.",
                  g_tp1Pct, g_tp2Pct, g_tp3Pct, sum);
      return false;
   }
   return true;
}

double BeOffsetPips()
{
   if(BreakEvenOffset == BE_OFF_PLUS1) return 1.0;
   if(BreakEvenOffset == BE_OFF_PLUS2) return 2.0;
   if(BreakEvenOffset == BE_OFF_PLUS5) return 5.0;
   return 0.0;
}

//+------------------------------------------------------------------+
//| Chart panel                                                       |
//+------------------------------------------------------------------+
string ConnColorTag()
{
   if(g_needsRepair) return "RED";
   if(g_connected) return "GREEN";
   return "YELLOW";
}

string ProgressSummary()
{
   string lines = "";
   int shown = 0;
   for(int i = 0; i < MAX_MANAGED && shown < 4; i++)
   {
      if(!g_managed[i].active) continue;
      string phase = "OPEN";
      if(g_managed[i].tp3Hit) phase = "TP3";
      else if(g_managed[i].tp2Hit) phase = "TP2";
      else if(g_managed[i].tp1Hit) phase = "TP1";
      if(g_managed[i].breakEvenDone) phase += "+BE";
      if(g_managed[i].trailArmed) phase += "+TR";
      if(StringLen(g_managed[i].pendingOp) > 0)
         phase += StringFormat("+RETRY(%s#%d)", g_managed[i].pendingOp, g_managed[i].retryCount);
      lines += StringFormat("\n  %s %s rem=%.2f [%s]",
         g_managed[i].symbol,
         g_managed[i].isBuy ? "BUY" : "SELL",
         g_managed[i].remainingVolume,
         phase);
      shown++;
   }
   if(shown == 0) return "\nTrades: none managed";
   return "\nManaged:" + lines;
}

void UpdateChartComment()
{
   RefreshBrokerSnapshot();
   double balance = AccountInfoDouble(ACCOUNT_BALANCE);
   double equity = AccountInfoDouble(ACCOUNT_EQUITY);
   string syncStr = g_lastSyncAt > 0 ? TimeToString(g_lastSyncAt, TIME_DATE|TIME_SECONDS) : "—";
   string hbStr = g_lastHeartbeat > 0 ? TimeToString(g_lastHeartbeat, TIME_SECONDS) : "—";
   string modeStr = (g_accountMode == ACCOUNT_TRADE_MODE_REAL) ? "Real"
                  : (g_accountMode == ACCOUNT_TRADE_MODE_DEMO) ? "Demo" : "Contest";
   string colorTag = ConnColorTag();

   string text;
   if(g_needsRepair)
      text = "Kaching AI v" + KACHING_EA_VERSION + "\nStatus: Connection Lost [" + colorTag + "]\nPlease Pair Again";
   else if(!g_connected)
      text = StringFormat("Kaching AI v%s\nStatus: %s [%s]\n%s",
         KACHING_EA_VERSION, g_statusLine, colorTag,
         StringLen(g_lastError) > 0 ? g_lastError : "Enter PairCode from dashboard");
   else
      text = StringFormat(
         "Kaching AI v%s\nStatus: Connected [%s]\nBroker: %s\nServer: %s\nAccount: %I64d (%s)\nBalance: %.2f %s\nEquity: %.2f\nRisk: %.2f%%\nPoll: %ds  Heartbeat: %s\nLast Sync: %s%s%s",
         KACHING_EA_VERSION, colorTag,
         g_brokerName, g_serverName, g_accountLogin, modeStr,
         balance, AccountInfoString(ACCOUNT_CURRENCY), equity,
         g_displayRiskPercent, MathMax(1, PollSeconds), hbStr, syncStr,
         ProgressSummary(),
         StringLen(g_panelExtra) > 0 ? ("\n" + g_panelExtra) : "");
   Comment(text);
}

//+------------------------------------------------------------------+
//| JSON helpers                                                      |
//+------------------------------------------------------------------+
string JsonGetString(const string json, const string key)
{
   string pattern = "\"" + key + "\":\"";
   int start = StringFind(json, pattern);
   if(start < 0) return "";
   start += StringLen(pattern);
   int end = StringFind(json, "\"", start);
   if(end < 0) return "";
   return StringSubstr(json, start, end - start);
}

double JsonGetNumber(const string json, const string key)
{
   string pattern = "\"" + key + "\":";
   int start = StringFind(json, pattern);
   if(start < 0) return 0;
   start += StringLen(pattern);
   string tail = StringSubstr(json, start);
   StringReplace(tail, " ", "");
   int end = StringFind(tail, ",");
   if(end < 0) end = StringFind(tail, "}");
   if(end < 0) return 0;
   return StringToDouble(StringSubstr(tail, 0, end));
}

bool JsonGetBool(const string json, const string key)
{
   string pattern = "\"" + key + "\":";
   int start = StringFind(json, pattern);
   if(start < 0) return false;
   string tail = StringSubstr(json, start + StringLen(pattern), 8);
   return StringFind(tail, "true") >= 0;
}

//+------------------------------------------------------------------+
//| HTTP                                                              |
//+------------------------------------------------------------------+
int HttpRequestRaw(const string method, const string url, const string body, const bool useToken, string &response)
{
   char data[];
   char result[];
   if(StringLen(body) > 0)
   {
      StringToCharArray(body, data, 0, WHOLE_ARRAY, CP_UTF8);
      ArrayResize(data, StringLen(body));
   }
   string headers = "";
   if(StringLen(body) > 0)
      headers += "Content-Type: application/json\r\n";
   if(useToken && StringLen(g_token) > 0)
      headers += "X-MT5-Token: " + g_token + "\r\n";
   ResetLastError();
   int code = WebRequest(method, url, headers, 15000, data, result, headers);
   if(code == -1)
   {
      response = "";
      return -1;
   }
   response = CharArrayToString(result);
   return code;
}

bool TryRefreshAccessToken()
{
   if(StringLen(g_refreshToken) == 0)
      return false;

   string url = EffectiveBackendUrl() + "/api/mt5/pair/refresh";
   string body = StringFormat("{\"refreshToken\":\"%s\",\"deviceId\":\"%s\"}", g_refreshToken, g_deviceId);
   string response;
   int code = HttpRequestRaw("POST", url, body, false, response);
   if(code < 200 || code >= 300)
   {
      Print("Token refresh failed HTTP ", code);
      ClearSavedCredentials();
      g_statusLine = "Connection Lost";
      g_lastError = "Please Pair Again";
      UpdateChartComment();
      return false;
   }

   string access = JsonGetString(response, "accessToken");
   if(StringLen(access) == 0)
      access = JsonGetString(response, "token");
   if(StringLen(access) == 0)
   {
      ClearSavedCredentials();
      return false;
   }
   g_token = access;
   g_accessExpiresAt = JsonGetString(response, "accessExpiresAt");
   SaveCredentials();
   g_needsRepair = false;
   MaybeReconcileManagedTrades("token_refresh", true);
   return true;
}

bool EnsureAccessToken()
{
   if(g_needsRepair) return false;
   return StringLen(g_token) > 0;
}

bool HttpGet(const string url, string &response)
{
   if(!EnsureAccessToken()) return false;
   int code = HttpRequestRaw("GET", url, "", true, response);
   if(code == -1)
   {
      g_statusLine = "Unable to reach Kaching AI";
      g_lastError = "Retrying...";
      UpdateChartComment();
      return false;
   }
   if(code == 401 && StringFind(response, "access_expired") >= 0)
   {
      if(TryRefreshAccessToken())
         code = HttpRequestRaw("GET", url, "", true, response);
      else
         return false;
   }
   if(code == 401)
   {
      ClearSavedCredentials();
      UpdateChartComment();
      return false;
   }
   return (code >= 200 && code < 300);
}

int HttpPostJsonAuthCode(const string url, const string body, string &response)
{
   if(!EnsureAccessToken()) return 0;
   int code = HttpRequestRaw("POST", url, body, true, response);
   if(code == -1)
   {
      g_statusLine = "Unable to reach Kaching AI";
      g_lastError = "Retrying...";
      UpdateChartComment();
      return -1;
   }
   if(code == 401 && StringFind(response, "access_expired") >= 0)
   {
      if(TryRefreshAccessToken())
         code = HttpRequestRaw("POST", url, body, true, response);
      else
         return 401;
   }
   if(code == 401)
   {
      ClearSavedCredentials();
      UpdateChartComment();
      return 401;
   }
   return code;
}

bool HttpPostJsonAuth(const string url, const string body, string &response)
{
   int code = HttpPostJsonAuthCode(url, body, response);
   return (code >= 200 && code < 300);
}

// Forward decls for idempotent reconciler (used from token refresh / heartbeat)
void ReconcileManagedTrades(const string reason = "manual");
void MaybeReconcileManagedTrades(const string reason, const bool force = false);

//+------------------------------------------------------------------+
//| Structured transaction log                                        |
//+------------------------------------------------------------------+
void TxLog(const string op, const string signalId, const ulong ticket,
           const string result, const string errorMsg, const int retry,
           const string recovery)
{
   PrintFormat("TX ts=%s sig=%s ticket=%I64u broker=%s op=%s result=%s error=%s retry=%d recovery=%s",
               TimeToString(TimeCurrent(), TIME_DATE|TIME_SECONDS),
               signalId, ticket, g_brokerName, op, result, errorMsg, retry, recovery);
}

bool TradeRetcodeOk(const uint retcode)
{
   return (retcode == TRADE_RETCODE_DONE ||
           retcode == TRADE_RETCODE_DONE_PARTIAL ||
           retcode == TRADE_RETCODE_PLACED);
}

int RetryBackoffSeconds(const int retryCount)
{
   if(retryCount <= 0) return 2;
   if(retryCount == 1) return 5;
   if(retryCount == 2) return 10;
   if(retryCount == 3) return 20;
   return 60;
}

void ClearPendingOp(ManagedTrade &mt)
{
   mt.pendingOp = "";
   mt.retryCount = 0;
   mt.nextRetryAt = 0;
   mt.lastRetryNote = "";
   if(StringFind(g_panelExtra, "Retry ") == 0)
      g_panelExtra = "";
}

void ScheduleRetry(ManagedTrade &mt, const string op, const string note)
{
   mt.pendingOp = op;
   mt.lastRetryNote = note;
   int delay = RetryBackoffSeconds(mt.retryCount);
   mt.nextRetryAt = TimeCurrent() + delay;
   mt.retryCount++;
   g_panelExtra = StringFormat("Retry %s in %ds (%s)", op, delay, note);
   TxLog(op, mt.signalId, mt.ticket, "retry_scheduled", note, mt.retryCount, "backoff");
}

bool RetryDue(const ManagedTrade &mt)
{
   if(StringLen(mt.pendingOp) == 0) return true;
   return (TimeCurrent() >= mt.nextRetryAt);
}

string NewEventUuid()
{
   g_eventSeq++;
   return StringFormat("%I64d-%d-%d-%d",
      (long)TimeGMT(), (int)GetTickCount(), g_eventSeq, MathRand());
}

//+------------------------------------------------------------------+
//| Idempotent broker ops — Expected vs Broker validation (v1.22)     |
//| Broker is source of truth. Validate → sync | execute.             |
//+------------------------------------------------------------------+
double VolumeEps(const string symbol)
{
   double step = SymbolInfoDouble(symbol, SYMBOL_VOLUME_STEP);
   if(step <= 0) step = 0.01;
   return MathMax(step * 0.51, 0.0000001);
}

double PriceEps(const string symbol)
{
   double point = SymbolInfoDouble(symbol, SYMBOL_POINT);
   if(point <= 0) point = 0.00001;
   return point;
}

bool SlEqualOrBetter(const bool isBuy, const double brokerSl, const double desiredSl, const double tol)
{
   if(desiredSl <= 0) return false;
   if(brokerSl <= 0) return false;
   if(isBuy)
      return (brokerSl + tol >= desiredSl);
   return (brokerSl - tol <= desiredSl);
}

bool ReadBrokerState(const ManagedTrade &mt, double &vol, double &sl, double &tp)
{
   vol = 0; sl = 0; tp = 0;
   if(mt.ticket == 0 || !PositionSelectByTicket(mt.ticket))
      return false;
   vol = PositionGetDouble(POSITION_VOLUME);
   sl = PositionGetDouble(POSITION_SL);
   tp = PositionGetDouble(POSITION_TP);
   return true;
}

double ExpectedRemainingAfterTpLevel(const ManagedTrade &mt, const int level)
{
   if(level >= 3) return 0;
   double pctClosed = 0;
   if(level >= 1) pctClosed += g_tp1Pct;
   if(level >= 2) pctClosed += g_tp2Pct;
   if(pctClosed >= 100.0) return 0;
   return mt.initialVolume * (100.0 - pctClosed) / 100.0;
}

// History OUT volume for position (broker truth beyond live remaining).
double ClosedVolumeFromHistory(const ulong ticket)
{
   if(ticket == 0 || !PositionSelectByTicket(ticket))
      return -1;
   ulong posId = (ulong)PositionGetInteger(POSITION_IDENTIFIER);
   if(posId == 0 || !HistorySelectByPosition(posId))
      return -1;
   double closed = 0;
   int total = HistoryDealsTotal();
   for(int i = 0; i < total; i++)
   {
      ulong deal = HistoryDealGetTicket(i);
      if(deal == 0) continue;
      long entry = HistoryDealGetInteger(deal, DEAL_ENTRY);
      if(entry == DEAL_ENTRY_OUT || entry == DEAL_ENTRY_OUT_BY)
         closed += HistoryDealGetDouble(deal, DEAL_VOLUME);
   }
   return closed;
}

// true = broker already reflects desired post-TP volume (skip OrderSend)
bool ValidatePartialAlreadyDone(const ManagedTrade &mt, const int level)
{
   double liveVol = 0, sl = 0, tp = 0;
   if(!ReadBrokerState(mt, liveVol, sl, tp))
      return false;
   if(mt.initialVolume <= 0)
      return false;

   double expected = ExpectedRemainingAfterTpLevel(mt, level);
   double eps = VolumeEps(mt.symbol);
   if(level >= 3)
      return (liveVol <= eps);

   // Live remaining already at/below expected after this TP
   if(liveVol <= expected + eps)
      return true;

   // History closed volume covers cumulative close through this level
   double histClosed = ClosedVolumeFromHistory(mt.ticket);
   if(histClosed >= 0)
   {
      double needClosed = mt.initialVolume - expected;
      if(histClosed + eps >= needClosed)
         return true;
   }

   // Closed fraction thresholds (aligned with reconciler)
   double closedFrac = (mt.initialVolume - liveVol) / mt.initialVolume;
   if(level == 1 && closedFrac >= 0.15) return true;
   if(level == 2 && closedFrac >= 0.45) return true;
   return false;
}

bool ValidateBeAlreadyDone(const ManagedTrade &mt, const double desiredBeSl)
{
   double liveVol = 0, sl = 0, tp = 0;
   if(!ReadBrokerState(mt, liveVol, sl, tp))
      return false;
   return SlEqualOrBetter(mt.isBuy, sl, desiredBeSl, PriceEps(mt.symbol));
}

bool ValidateTrailAlreadyDone(const ManagedTrade &mt, const double desiredTrailSl)
{
   double liveVol = 0, sl = 0, tp = 0;
   if(!ReadBrokerState(mt, liveVol, sl, tp))
      return false;
   // Same or better than requested trail (no step requirement — already applied)
   return SlEqualOrBetter(mt.isBuy, sl, desiredTrailSl, PriceEps(mt.symbol));
}

void LogBrokerDecision(const string op, const ManagedTrade &mt,
                       const string decision, const string detail)
{
   // decision: "sync" (skipped — already on broker) | "execute" | "repair"
   TxLog(op, mt.signalId, mt.ticket, decision, detail, mt.retryCount, "idempotent");
}

//+------------------------------------------------------------------+
//| Pip / ATR helpers                                                 |
//+------------------------------------------------------------------+
double PipSize(const string symbol)
{
   double point = SymbolInfoDouble(symbol, SYMBOL_POINT);
   int digits = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
   if(digits == 3 || digits == 5)
      return point * 10.0;
   return point > 0 ? point : 0.0001;
}

double PipsToPrice(const string symbol, const double pips)
{
   return pips * PipSize(symbol);
}

double GetATR(const string symbol, const int period)
{
   int handle = iATR(symbol, ATR_TIMEFRAME, period);
   if(handle == INVALID_HANDLE) return 0;
   double buf[];
   ArraySetAsSeries(buf, true);
   if(CopyBuffer(handle, 0, 0, 2, buf) <= 0)
   {
      IndicatorRelease(handle);
      return 0;
   }
   double v = buf[0];
   IndicatorRelease(handle);
   return v;
}

double SwingLow(const string symbol, const int bars)
{
   double lo = 0;
   for(int i = 1; i <= bars; i++)
   {
      double h = iLow(symbol, ATR_TIMEFRAME, i);
      if(lo == 0 || h < lo) lo = h;
   }
   return lo;
}

double SwingHigh(const string symbol, const int bars)
{
   double hi = 0;
   for(int i = 1; i <= bars; i++)
   {
      double h = iHigh(symbol, ATR_TIMEFRAME, i);
      if(h > hi) hi = h;
   }
   return hi;
}

//+------------------------------------------------------------------+
//| Broker filling mode (never hardcode FOK only)                     |
//+------------------------------------------------------------------+
ENUM_ORDER_TYPE_FILLING DetectFillingMode(const string symbol)
{
   uint filling = (uint)SymbolInfoInteger(symbol, SYMBOL_FILLING_MODE);
   // Prefer IOC for market deals; then FOK; then RETURN (exchange/partial ok)
   if((filling & SYMBOL_FILLING_IOC) == SYMBOL_FILLING_IOC)
      return ORDER_FILLING_IOC;
   if((filling & SYMBOL_FILLING_FOK) == SYMBOL_FILLING_FOK)
      return ORDER_FILLING_FOK;
   return ORDER_FILLING_RETURN;
}

double NormalizeVolume(const string symbol, double volume)
{
   double vmin = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MIN);
   double vmax = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MAX);
   double step = SymbolInfoDouble(symbol, SYMBOL_VOLUME_STEP);
   if(step <= 0) step = 0.01;
   if(vmin <= 0) vmin = step;
   if(volume < vmin) return 0;
   if(volume > vmax) volume = vmax;
   double steps = MathFloor((volume / step) + 1e-8);
   double out = steps * step;
   int volDigits = 2;
   if(step < 0.01) volDigits = 3;
   if(step < 0.001) volDigits = 4;
   out = NormalizeDouble(out, volDigits);
   if(out < vmin) return 0;
   return out;
}

void LogBrokerSymbolInfo(const string symbol)
{
   PrintFormat("BrokerInfo symbol=%s digits=%d point=%.8f contract=%.2f min=%.4f max=%.4f step=%.4f spread=%d fill=%d",
      symbol,
      (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS),
      SymbolInfoDouble(symbol, SYMBOL_POINT),
      SymbolInfoDouble(symbol, SYMBOL_TRADE_CONTRACT_SIZE),
      SymbolInfoDouble(symbol, SYMBOL_VOLUME_MIN),
      SymbolInfoDouble(symbol, SYMBOL_VOLUME_MAX),
      SymbolInfoDouble(symbol, SYMBOL_VOLUME_STEP),
      (int)SymbolInfoInteger(symbol, SYMBOL_SPREAD),
      (int)DetectFillingMode(symbol));
}

//+------------------------------------------------------------------+
//| Auto symbol mapping                                               |
//+------------------------------------------------------------------+
string CompactBase(const string s)
{
   string u = s;
   StringToUpper(u);
   string out = "";
   for(int i = 0; i < StringLen(u); i++)
   {
      ushort c = StringGetCharacter(u, i);
      if((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9'))
         out += CharToString((uchar)c);
   }
   // Strip common broker noise suffixes from compact form for compare
   int n = StringLen(out);
   if(n > 3)
   {
      string tail3 = StringSubstr(out, n - 3);
      if(tail3 == "PRO" || tail3 == "RAW" || tail3 == "ECN")
         out = StringSubstr(out, 0, n - 3);
   }
   return out;
}

void BuildSymbolCache()
{
   g_symbolCacheCount = 0;
   int total = SymbolsTotal(false);
   for(int i = 0; i < total && g_symbolCacheCount < MAX_SYMBOL_CACHE; i++)
   {
      string name = SymbolName(i, false);
      if(StringLen(name) == 0) continue;
      g_symbolCache[g_symbolCacheCount++] = name;
   }
   g_symbolCacheBuilt = TimeCurrent();
   PrintFormat("Symbol cache built: %d symbols", g_symbolCacheCount);
}

bool SymbolExistsTradable(const string symbol)
{
   if(!SymbolSelect(symbol, true))
      return false;
   // Prefer symbols that allow trading
   long mode = SymbolInfoInteger(symbol, SYMBOL_TRADE_MODE);
   if(mode == SYMBOL_TRADE_MODE_DISABLED)
      return false;
   return true;
}

string MapAliasBase(const string compact)
{
   if(compact == "GOLD" || compact == "XAUUSD" || StringFind(compact, "XAU") == 0)
      return "XAUUSD";
   if(compact == "SILVER" || compact == "XAGUSD" || StringFind(compact, "XAG") == 0)
      return "XAGUSD";
   if(compact == "US30" || compact == "DJ30" || compact == "DJIA" || compact == "WALLSTREET30")
      return "US30";
   if(compact == "US100" || compact == "NAS100" || compact == "USTEC" || compact == "NDX")
      return "US100";
   if(compact == "BTCUSD" || compact == "BTCUSDT")
      return "BTCUSD";
   return compact;
}

string ResolveBrokerSymbol(const string requested)
{
   string req = requested;
   StringTrimLeft(req); StringTrimRight(req);
   if(StringLen(req) == 0) return "";

   // Optional manual suffix override (dashboard / input)
   string withSuffix = req;
   if(StringLen(SymbolSuffixOverride) > 0 && StringFind(req, SymbolSuffixOverride) < 0)
      withSuffix = req + SymbolSuffixOverride;

   if(SymbolExistsTradable(withSuffix))
      return withSuffix;
   if(SymbolExistsTradable(req))
      return req;

   if(g_symbolCacheCount == 0 || TimeCurrent() - g_symbolCacheBuilt > 3600)
      BuildSymbolCache();

   string want = MapAliasBase(CompactBase(req));
   string best = "";
   int bestScore = -1;

   for(int i = 0; i < g_symbolCacheCount; i++)
   {
      string cand = g_symbolCache[i];
      string cbase = MapAliasBase(CompactBase(cand));
      int score = -1;
      if(cbase == want) score = 100;
      else if(StringFind(cbase, want) == 0) score = 80;
      else if(StringFind(want, cbase) == 0 && StringLen(cbase) >= 4) score = 60;
      else if(StringFind(cand, req) >= 0) score = 40;

      // Prefer shorter / cleaner names on tie
      if(score > bestScore || (score == bestScore && score >= 0 && StringLen(cand) < StringLen(best)))
      {
         if(SymbolExistsTradable(cand))
         {
            bestScore = score;
            best = cand;
         }
      }
   }

   // Alias expansion: GOLD↔XAUUSD, DJ30↔US30
   if(bestScore < 0)
   {
      string alts[6];
      int nAlt = 0;
      if(want == "XAUUSD") { alts[0] = "GOLD"; alts[1] = "XAUUSD"; nAlt = 2; }
      else if(want == "US30") { alts[0] = "DJ30"; alts[1] = "US30"; alts[2] = "DJIA"; nAlt = 3; }
      else { alts[0] = want; nAlt = 1; }

      for(int a = 0; a < nAlt; a++)
      {
         for(int i = 0; i < g_symbolCacheCount; i++)
         {
            string cand = g_symbolCache[i];
            if(MapAliasBase(CompactBase(cand)) == MapAliasBase(CompactBase(alts[a])))
            {
               if(SymbolExistsTradable(cand))
                  return cand;
            }
         }
      }
   }

   return best;
}

//+------------------------------------------------------------------+
//| Managed state persistence (Common Files)                          |
//+------------------------------------------------------------------+
string EscField(const string s)
{
   string o = s;
   StringReplace(o, "|", "/");
   StringReplace(o, "\n", " ");
   return o;
}

string BuildManagedSnapshot()
{
   string snap = "";
   for(int i = 0; i < MAX_MANAGED; i++)
   {
      if(!g_managed[i].active) continue;
      snap += StringFormat("%s|%I64u|%.4f|%d%d%d%d%d;",
         g_managed[i].executionId, g_managed[i].ticket, g_managed[i].remainingVolume,
         g_managed[i].tp1Hit ? 1 : 0, g_managed[i].tp2Hit ? 1 : 0, g_managed[i].tp3Hit ? 1 : 0,
         g_managed[i].breakEvenDone ? 1 : 0, g_managed[i].trailArmed ? 1 : 0);
   }
   return snap;
}

void PersistManagedTrades(const bool force = false)
{
   string snap = BuildManagedSnapshot();
   if(!force && snap == g_managedSnapshot && !g_managedDirty)
      return;

   int handle = FileOpen(MANAGED_FILE, FILE_WRITE|FILE_TXT|FILE_ANSI|FILE_COMMON);
   if(handle == INVALID_HANDLE)
   {
      Print("Persist managed failed: ", GetLastError());
      return;
   }
   FileWriteString(handle, "v1\n");
   for(int i = 0; i < MAX_MANAGED; i++)
   {
      if(!g_managed[i].active) continue;
      // signalId|executionId|ticket|symbol|isBuy|entry|sl|tp1|tp2|tp3|initVol|remVol|tp1|tp2|tp3|be|trail|magic|comment
      string line = StringFormat(
         "%s|%s|%I64u|%s|%d|%.8f|%.8f|%.8f|%.8f|%.8f|%.4f|%.4f|%d|%d|%d|%d|%d|%d|%s\n",
         EscField(g_managed[i].signalId),
         EscField(g_managed[i].executionId),
         g_managed[i].ticket,
         EscField(g_managed[i].symbol),
         g_managed[i].isBuy ? 1 : 0,
         g_managed[i].entry,
         g_managed[i].initialSl,
         g_managed[i].tp1,
         g_managed[i].tp2,
         g_managed[i].tp3,
         g_managed[i].initialVolume,
         g_managed[i].remainingVolume,
         g_managed[i].tp1Hit ? 1 : 0,
         g_managed[i].tp2Hit ? 1 : 0,
         g_managed[i].tp3Hit ? 1 : 0,
         g_managed[i].breakEvenDone ? 1 : 0,
         g_managed[i].trailArmed ? 1 : 0,
         g_managed[i].magic,
         EscField(g_managed[i].comment)
      );
      FileWriteString(handle, line);
   }
   FileClose(handle);
   g_managedSnapshot = snap;
   g_managedDirty = false;
}

int SplitPipe(const string line, string &parts[])
{
   int count = 0;
   string rest = line;
   ArrayResize(parts, 0);
   while(true)
   {
      int p = StringFind(rest, "|");
      string piece;
      if(p < 0)
      {
         piece = rest;
         ArrayResize(parts, count + 1);
         parts[count++] = piece;
         break;
      }
      piece = StringSubstr(rest, 0, p);
      ArrayResize(parts, count + 1);
      parts[count++] = piece;
      rest = StringSubstr(rest, p + 1);
   }
   return count;
}

int FindManagedSlot()
{
   for(int i = 0; i < MAX_MANAGED; i++)
   {
      if(!g_managed[i].active)
         return i;
   }
   return -1;
}

int FindManagedByTicket(const ulong ticket)
{
   for(int i = 0; i < MAX_MANAGED; i++)
   {
      if(g_managed[i].active && g_managed[i].ticket == ticket)
         return i;
   }
   return -1;
}

int FindManagedBySignal(const string signalId)
{
   if(StringLen(signalId) == 0) return -1;
   for(int i = 0; i < MAX_MANAGED; i++)
   {
      if(g_managed[i].active && g_managed[i].signalId == signalId)
         return i;
   }
   return -1;
}

int FindManagedByExecution(const string executionId)
{
   if(StringLen(executionId) == 0) return -1;
   for(int i = 0; i < MAX_MANAGED; i++)
   {
      if(g_managed[i].active && g_managed[i].executionId == executionId)
         return i;
   }
   return -1;
}

bool PositionMatchesMagicComment(const ulong ticket, const int magic, const string comment)
{
   if(!PositionSelectByTicket(ticket)) return false;
   if((int)PositionGetInteger(POSITION_MAGIC) != magic) return false;
   if(StringLen(comment) > 0)
   {
      string pc = PositionGetString(POSITION_COMMENT);
      if(StringFind(pc, comment) < 0 && StringFind(comment, pc) < 0 && pc != comment)
      {
         // Allow match on Kaching#executionId fragment
         if(StringFind(pc, "Kaching#") < 0)
            return false;
      }
   }
   return true;
}

void LoadManagedTrades()
{
   if(!FileIsExist(MANAGED_FILE, FILE_COMMON))
      return;

   int handle = FileOpen(MANAGED_FILE, FILE_READ|FILE_TXT|FILE_ANSI|FILE_COMMON);
   if(handle == INVALID_HANDLE)
      return;

   string ver = FileReadString(handle);
   StringTrimLeft(ver); StringTrimRight(ver);
   int restored = 0;

   while(!FileIsEnding(handle))
   {
      string line = FileReadString(handle);
      StringTrimLeft(line); StringTrimRight(line);
      if(StringLen(line) == 0) continue;

      string parts[];
      int n = SplitPipe(line, parts);
      if(n < 18) continue;

      ulong ticket = (ulong)StringToInteger(parts[2]);
      int magic = (int)StringToInteger(parts[17]);
      string comment = parts[18];
      string symbol = parts[3];

      // Reconstruct only if position still exists (or netting volume remains)
      bool alive = false;
      if(ticket > 0 && PositionSelectByTicket(ticket))
         alive = true;
      else
      {
         // Hedging/netting fallback: find by magic+symbol+comment
         for(int p = PositionsTotal() - 1; p >= 0; p--)
         {
            ulong t = PositionGetTicket(p);
            if(t == 0) continue;
            if((int)PositionGetInteger(POSITION_MAGIC) != magic) continue;
            if(PositionGetString(POSITION_SYMBOL) != symbol) continue;
            string pc = PositionGetString(POSITION_COMMENT);
            if(StringLen(parts[1]) > 0 && StringFind(pc, parts[1]) >= 0)
            {
               ticket = t;
               alive = true;
               break;
            }
            if(StringLen(comment) > 0 && (pc == comment || StringFind(pc, comment) >= 0))
            {
               ticket = t;
               alive = true;
               break;
            }
         }
      }

      if(!alive) continue;

      int slot = FindManagedSlot();
      if(slot < 0) break;

      g_managed[slot].signalId = parts[0];
      g_managed[slot].executionId = parts[1];
      g_managed[slot].ticket = ticket;
      g_managed[slot].symbol = symbol;
      g_managed[slot].isBuy = (StringToInteger(parts[4]) != 0);
      g_managed[slot].entry = StringToDouble(parts[5]);
      g_managed[slot].initialSl = StringToDouble(parts[6]);
      g_managed[slot].tp1 = StringToDouble(parts[7]);
      g_managed[slot].tp2 = StringToDouble(parts[8]);
      g_managed[slot].tp3 = StringToDouble(parts[9]);
      g_managed[slot].initialVolume = StringToDouble(parts[10]);
      g_managed[slot].remainingVolume = PositionGetDouble(POSITION_VOLUME);
      g_managed[slot].tp1Hit = (StringToInteger(parts[12]) != 0);
      g_managed[slot].tp2Hit = (StringToInteger(parts[13]) != 0);
      g_managed[slot].tp3Hit = (StringToInteger(parts[14]) != 0);
      g_managed[slot].breakEvenDone = (StringToInteger(parts[15]) != 0);
      g_managed[slot].trailArmed = (StringToInteger(parts[16]) != 0);
      g_managed[slot].trailReported = g_managed[slot].trailArmed;
      g_managed[slot].magic = magic;
      g_managed[slot].comment = comment;
      g_managed[slot].initialR = MathAbs(g_managed[slot].entry - g_managed[slot].initialSl);
      g_managed[slot].pendingOp = "";
      g_managed[slot].retryCount = 0;
      g_managed[slot].nextRetryAt = 0;
      g_managed[slot].lastRetryNote = "";
      g_managed[slot].active = true;
      restored++;
   }
   FileClose(handle);
   PrintFormat("Restored %d managed trades from %s", restored, MANAGED_FILE);
}

void MaybeArmTrail(ManagedTrade &mt); // forward — used by reconciler

//+------------------------------------------------------------------+
//| Reconciler — file + live position + history (never file-only)     |
//| Triggers: OnInit, reconnect, heartbeat recovery, token, every 60s |
//+------------------------------------------------------------------+
void ReconcileManagedTrades(const string reason/*="manual"*/)
{
   bool any = false;
   for(int i = 0; i < MAX_MANAGED; i++)
   {
      if(!g_managed[i].active) continue;
      // Never trust file alone — position must exist on broker
      if(!PositionSelectByTicket(g_managed[i].ticket)) continue;

      double rem = PositionGetDouble(POSITION_VOLUME);
      double sl = PositionGetDouble(POSITION_SL);
      double initVol = g_managed[i].initialVolume;
      double eps = VolumeEps(g_managed[i].symbol);
      bool repaired = false;

      g_managed[i].remainingVolume = rem;

      // History closed volume (broker) — preferred when available
      double histClosed = ClosedVolumeFromHistory(g_managed[i].ticket);
      double closedFromLive = (initVol > 0) ? (initVol - rem) : 0;
      double closedVol = (histClosed >= 0) ? MathMax(histClosed, closedFromLive) : closedFromLive;

      if(initVol > 0)
      {
         double closedFrac = closedVol / initVol;
         double exp1 = ExpectedRemainingAfterTpLevel(g_managed[i], 1);
         double exp2 = ExpectedRemainingAfterTpLevel(g_managed[i], 2);

         if(!g_managed[i].tp1Hit && (rem <= exp1 + eps || closedFrac >= 0.15))
         {
            g_managed[i].tp1Hit = true;
            repaired = true;
            LogBrokerDecision("TP1", g_managed[i], "repair",
                              StringFormat("vol=%.4f reason=%s", rem, reason));
         }
         if(!g_managed[i].tp2Hit && (rem <= exp2 + eps || closedFrac >= 0.45))
         {
            g_managed[i].tp2Hit = true;
            repaired = true;
            LogBrokerDecision("TP2", g_managed[i], "repair",
                              StringFormat("vol=%.4f reason=%s", rem, reason));
         }
         if(!g_managed[i].tp3Hit && rem <= eps)
         {
            g_managed[i].tp3Hit = true;
            repaired = true;
         }

         // Flags said TP done but volume untouched → clear (pre-confirm mark bug)
         if(g_managed[i].tp1Hit && MathAbs(rem - initVol) < eps && closedFrac < 0.01)
         {
            g_managed[i].tp1Hit = false;
            g_managed[i].tp2Hit = false;
            g_managed[i].tp3Hit = false;
            repaired = true;
            TxLog("recovery", g_managed[i].signalId, g_managed[i].ticket,
                  "cleared_tp_flags", "volume_unchanged", 0, reason);
         }
      }

      if(sl > 0 && g_managed[i].entry > 0)
      {
         double beOffset = PipsToPrice(g_managed[i].symbol, BeOffsetPips());
         double beSl = g_managed[i].isBuy
            ? (g_managed[i].entry + beOffset)
            : (g_managed[i].entry - beOffset);
         bool atBe = SlEqualOrBetter(g_managed[i].isBuy, sl, beSl, PriceEps(g_managed[i].symbol)) ||
                     (g_managed[i].isBuy ? (sl >= g_managed[i].entry) : (sl <= g_managed[i].entry));
         if(atBe && !g_managed[i].breakEvenDone)
         {
            g_managed[i].breakEvenDone = true;
            repaired = true;
            LogBrokerDecision("BE", g_managed[i], "repair",
                              StringFormat("sl=%.5f reason=%s", sl, reason));
         }
         else if(g_managed[i].breakEvenDone && g_managed[i].initialSl > 0)
         {
            double distInit = MathAbs(g_managed[i].entry - g_managed[i].initialSl);
            bool nearInit = (MathAbs(sl - g_managed[i].initialSl) < distInit * 0.25) &&
                            (g_managed[i].isBuy ? sl < g_managed[i].entry : sl > g_managed[i].entry);
            if(nearInit)
            {
               g_managed[i].breakEvenDone = false;
               repaired = true;
               TxLog("recovery", g_managed[i].signalId, g_managed[i].ticket,
                     "cleared_be_flag", "sl_near_initial", 0, reason);
            }
         }

         // Trail: SL beyond BE while trail armed/start condition met → sync reported
         MaybeArmTrail(g_managed[i]);
         if(g_managed[i].trailArmed && TrailingMode != TRAIL_DISABLED &&
            g_managed[i].breakEvenDone && !g_managed[i].trailReported)
         {
            bool trailLike = g_managed[i].isBuy
               ? (sl > g_managed[i].entry + PriceEps(g_managed[i].symbol))
               : (sl > 0 && sl < g_managed[i].entry - PriceEps(g_managed[i].symbol));
            if(trailLike)
            {
               g_managed[i].trailReported = true;
               repaired = true;
               LogBrokerDecision("Trail", g_managed[i], "repair",
                                 StringFormat("sl=%.5f reason=%s", sl, reason));
            }
         }
      }

      // Clear stale pending ops that broker already satisfied
      if(StringLen(g_managed[i].pendingOp) > 0)
      {
         string pop = g_managed[i].pendingOp;
         bool done = false;
         if(pop == "tp1" && g_managed[i].tp1Hit) done = true;
         else if(pop == "tp2" && g_managed[i].tp2Hit) done = true;
         else if(pop == "tp3" && g_managed[i].tp3Hit) done = true;
         else if(pop == "be" && g_managed[i].breakEvenDone) done = true;
         if(done)
         {
            ClearPendingOp(g_managed[i]);
            repaired = true;
            LogBrokerDecision(pop, g_managed[i], "sync", "pending_cleared_by_broker");
         }
      }

      if(repaired)
      {
         any = true;
         TxLog("recovery", g_managed[i].signalId, g_managed[i].ticket,
               "repaired", reason, 0, "reconcile");
      }
   }
   g_lastReconcileAt = TimeCurrent();
   if(any)
   {
      g_managedDirty = true;
      PersistManagedTrades(true);
   }
}

void MaybeReconcileManagedTrades(const string reason, const bool force)
{
   if(!force && g_lastReconcileAt > 0 &&
      (TimeCurrent() - g_lastReconcileAt) < RECONCILE_SECONDS)
      return;
   ReconcileManagedTrades(reason);
}

//+------------------------------------------------------------------+
//| Durable event queue (Common Files)                                |
//+------------------------------------------------------------------+
void PersistEventQueue()
{
   int handle = FileOpen(EVENT_QUEUE_FILE, FILE_WRITE|FILE_TXT|FILE_ANSI|FILE_COMMON);
   if(handle == INVALID_HANDLE)
   {
      Print("Persist event queue failed: ", GetLastError());
      return;
   }
   FileWriteString(handle, "v1\n");
   for(int i = 0; i < MAX_EVENT_QUEUE; i++)
   {
      if(!g_eventQueue[i].active) continue;
      string line = StringFormat(
         "%s|%s|%s|%s|%I64u|%.8f|%.4f|%.4f|%.2f|%s\n",
         EscField(g_eventQueue[i].eventUuid),
         EscField(g_eventQueue[i].executionId),
         EscField(g_eventQueue[i].status),
         EscField(g_eventQueue[i].eventName),
         g_eventQueue[i].ticket,
         g_eventQueue[i].price,
         g_eventQueue[i].remainingVol,
         g_eventQueue[i].partialVol,
         g_eventQueue[i].partialPct,
         EscField(g_eventQueue[i].errorMessage)
      );
      FileWriteString(handle, line);
   }
   FileClose(handle);
}

void LoadEventQueue()
{
   for(int i = 0; i < MAX_EVENT_QUEUE; i++)
      g_eventQueue[i].active = false;

   if(!FileIsExist(EVENT_QUEUE_FILE, FILE_COMMON))
      return;

   int handle = FileOpen(EVENT_QUEUE_FILE, FILE_READ|FILE_TXT|FILE_ANSI|FILE_COMMON);
   if(handle == INVALID_HANDLE)
      return;

   string ver = FileReadString(handle);
   int loaded = 0;
   while(!FileIsEnding(handle) && loaded < MAX_EVENT_QUEUE)
   {
      string line = FileReadString(handle);
      StringTrimLeft(line); StringTrimRight(line);
      if(StringLen(line) == 0) continue;
      string parts[];
      int n = SplitPipe(line, parts);
      if(n < 9) continue;

      int slot = -1;
      for(int s = 0; s < MAX_EVENT_QUEUE; s++)
      {
         if(!g_eventQueue[s].active) { slot = s; break; }
      }
      if(slot < 0) break;

      g_eventQueue[slot].active = true;
      g_eventQueue[slot].eventUuid = parts[0];
      g_eventQueue[slot].executionId = parts[1];
      g_eventQueue[slot].status = parts[2];
      g_eventQueue[slot].eventName = parts[3];
      g_eventQueue[slot].ticket = (ulong)StringToInteger(parts[4]);
      g_eventQueue[slot].price = StringToDouble(parts[5]);
      g_eventQueue[slot].remainingVol = StringToDouble(parts[6]);
      g_eventQueue[slot].partialVol = StringToDouble(parts[7]);
      g_eventQueue[slot].partialPct = StringToDouble(parts[8]);
      g_eventQueue[slot].errorMessage = (n > 9) ? parts[9] : "";
      loaded++;
   }
   FileClose(handle);
   if(loaded > 0)
      PrintFormat("Restored %d queued events from %s", loaded, EVENT_QUEUE_FILE);
}

int FindEventQueueSlot()
{
   for(int i = 0; i < MAX_EVENT_QUEUE; i++)
   {
      if(!g_eventQueue[i].active)
         return i;
   }
   return -1;
}

bool PostQueuedEvent(const int idx)
{
   if(idx < 0 || idx >= MAX_EVENT_QUEUE || !g_eventQueue[idx].active)
      return false;

   string url = EffectiveBackendUrl() + "/api/mt5/bridge/report";
   string err = g_eventQueue[idx].errorMessage;
   StringReplace(err, "\"", "'");
   string ev = g_eventQueue[idx].eventName;
   StringReplace(ev, "\"", "'");
   string st = g_eventQueue[idx].status;
   StringReplace(st, "\"", "'");
   string uuid = g_eventQueue[idx].eventUuid;
   StringReplace(uuid, "\"", "'");

   string body = StringFormat(
      "{\"executionId\":\"%s\",\"status\":\"%s\",\"event\":\"%s\",\"eventUuid\":\"%s\",\"ticket\":\"%I64u\",\"fillPrice\":%.5f,\"price\":%.5f,\"remainingVolume\":%.4f,\"partialVolume\":%.4f,\"partialClosePercent\":%.2f,\"balance\":%.2f,\"currency\":\"%s\",\"error\":\"%s\",\"eaVersion\":\"%s\"}",
      g_eventQueue[idx].executionId, st, ev, uuid, g_eventQueue[idx].ticket,
      g_eventQueue[idx].price, g_eventQueue[idx].price,
      g_eventQueue[idx].remainingVol, g_eventQueue[idx].partialVol, g_eventQueue[idx].partialPct,
      AccountInfoDouble(ACCOUNT_BALANCE),
      AccountInfoString(ACCOUNT_CURRENCY),
      err,
      KACHING_EA_VERSION
   );

   string response;
   int code = HttpPostJsonAuthCode(url, body, response);
   bool acked = (code == 200 && JsonGetBool(response, "acknowledged"));
   TxLog("Report", g_eventQueue[idx].executionId, g_eventQueue[idx].ticket,
         acked ? "acked" : "keep",
         StringFormat("http=%d ev=%s", code, ev), 0,
         acked ? "removed" : "queued");

   if(acked)
   {
      g_eventQueue[idx].active = false;
      PersistEventQueue();
      return true;
   }
   return false;
}

void FlushEventQueue()
{
   for(int i = 0; i < MAX_EVENT_QUEUE; i++)
   {
      if(!g_eventQueue[i].active) continue;
      PostQueuedEvent(i);
   }
}

void EnqueueTradeEvent(const string executionId, const string status, const string eventName,
                       ulong ticket, double price, double remainingVol, double partialVol,
                       double partialPct, const string errorMessage)
{
   if(StringLen(executionId) == 0) return;

   int slot = FindEventQueueSlot();
   if(slot < 0)
   {
      // Drop oldest
      for(int i = 0; i < MAX_EVENT_QUEUE - 1; i++)
         g_eventQueue[i] = g_eventQueue[i + 1];
      slot = MAX_EVENT_QUEUE - 1;
   }

   g_eventQueue[slot].active = true;
   g_eventQueue[slot].eventUuid = NewEventUuid();
   g_eventQueue[slot].executionId = executionId;
   g_eventQueue[slot].status = status;
   g_eventQueue[slot].eventName = eventName;
   g_eventQueue[slot].ticket = ticket;
   g_eventQueue[slot].price = price;
   g_eventQueue[slot].remainingVol = remainingVol;
   g_eventQueue[slot].partialVol = partialVol;
   g_eventQueue[slot].partialPct = partialPct;
   g_eventQueue[slot].errorMessage = errorMessage;

   PersistEventQueue(); // durable before POST
   PostQueuedEvent(slot);
}

//+------------------------------------------------------------------+
//| Pairing / heartbeat / sync                                        |
//+------------------------------------------------------------------+
bool CompletePairing()
{
   g_statusLine = "Connecting...";
   g_lastError = "";
   g_needsRepair = false;
   UpdateChartComment();

   string bootstrap = KACHING_DEFAULT_BACKEND;
   string url = bootstrap + "/api/mt5/pair/complete";
   string broker = AccountInfoString(ACCOUNT_COMPANY);
   StringReplace(broker, "\\", "/");
   StringReplace(broker, "\"", "'");
   string fingerprint = MachineFingerprint();
   StringReplace(fingerprint, "\\", "/");
   StringReplace(fingerprint, "\"", "'");
   string pair = PairCode;
   StringTrimLeft(pair); StringTrimRight(pair); StringToUpper(pair);

   string body = StringFormat(
      "{\"pairCode\":\"%s\",\"terminalId\":\"%d\",\"accountNumber\":\"%I64d\",\"broker\":\"%s\",\"terminalBuild\":\"%d\",\"eaVersion\":\"%s\",\"machineFingerprint\":\"%s\",\"platform\":\"Windows\"}",
      pair,
      TerminalInfoInteger(TERMINAL_BUILD),
      AccountInfoInteger(ACCOUNT_LOGIN),
      broker,
      TerminalInfoInteger(TERMINAL_BUILD),
      KACHING_EA_VERSION,
      fingerprint
   );

   string response;
   int httpCode = HttpRequestRaw("POST", url, body, false, response);
   if(httpCode == -1)
   {
      g_lastError = "Unable to reach Kaching AI — Retrying...";
      g_statusLine = "Unable to reach Kaching AI";
      UpdateChartComment();
      return false;
   }
   if(httpCode == 410 || StringFind(response, "Pair Code Expired") >= 0 || StringFind(response, "\"expired\"") >= 0)
   {
      g_lastError = "Pair Code Expired";
      g_statusLine = "Pair Code Expired";
      UpdateChartComment();
      return false;
   }
   if(httpCode < 200 || httpCode >= 300)
   {
      g_lastError = "Invalid Pair Code";
      g_statusLine = "Invalid Pair Code";
      UpdateChartComment();
      return false;
   }

   string access = JsonGetString(response, "accessToken");
   if(StringLen(access) == 0) access = JsonGetString(response, "token");
   string refresh = JsonGetString(response, "refreshToken");
   string backendUrl = JsonGetString(response, "backendUrl");
   string subscriberId = JsonGetString(response, "subscriberId");
   string deviceId = JsonGetString(response, "deviceId");
   string accessExp = JsonGetString(response, "accessExpiresAt");

   if(StringLen(access) == 0 || StringLen(backendUrl) == 0)
   {
      g_lastError = "Invalid Pair Code";
      g_statusLine = "Invalid Pair Code";
      UpdateChartComment();
      return false;
   }

   g_token = access;
   g_refreshToken = refresh;
   g_backendUrl = backendUrl;
   g_subscriberId = subscriberId;
   g_deviceId = deviceId;
   g_accessExpiresAt = accessExp;
   SaveCredentials();

   g_connected = true;
   g_needsRepair = false;
   g_statusLine = "Connected";
   g_lastError = "";
   UpdateChartComment();
   Print("KachingTradeCopier paired. Device=", g_deviceId, " Backend=", g_backendUrl);
   return true;
}

void SendHeartbeat()
{
   string url = EffectiveBackendUrl() + "/api/mt5/bridge/heartbeat";
   string broker = AccountInfoString(ACCOUNT_COMPANY);
   StringReplace(broker, "\"", "'");
   string body = StringFormat(
      "{\"balance\":%.2f,\"currency\":\"%s\",\"broker\":\"%s\",\"accountNumber\":\"%I64d\",\"deviceId\":\"%s\",\"equity\":%.2f,\"eaVersion\":\"%s\"}",
      AccountInfoDouble(ACCOUNT_BALANCE),
      AccountInfoString(ACCOUNT_CURRENCY),
      broker,
      AccountInfoInteger(ACCOUNT_LOGIN),
      g_deviceId,
      AccountInfoDouble(ACCOUNT_EQUITY),
      KACHING_EA_VERSION
   );
   string response;
   bool wasUp = g_wasConnected;
   if(HttpPostJsonAuth(url, body, response))
   {
      g_lastHeartbeat = TimeCurrent();
      g_lastSyncAt = TimeCurrent();
      g_connected = true;
      g_statusLine = "Connected";
      // Heartbeat recovery / reconnect → reconcile broker vs local
      if(!wasUp)
         MaybeReconcileManagedTrades("heartbeat_reconnect", true);
      g_wasConnected = true;
      UpdateChartComment();
   }
   else
   {
      g_wasConnected = false;
   }
}

void SyncAccount()
{
   string url = EffectiveBackendUrl() + "/api/mt5/bridge/sync";
   string body = StringFormat(
      "{\"balance\":%.2f,\"currency\":\"%s\",\"terminalId\":\"%d\",\"accountNumber\":\"%I64d\",\"equity\":%.2f}",
      AccountInfoDouble(ACCOUNT_BALANCE),
      AccountInfoString(ACCOUNT_CURRENCY),
      TerminalInfoInteger(TERMINAL_BUILD),
      AccountInfoInteger(ACCOUNT_LOGIN),
      AccountInfoDouble(ACCOUNT_EQUITY)
   );
   string response;
   if(HttpPostJsonAuth(url, body, response))
   {
      g_lastSyncAt = TimeCurrent();
      g_connected = true;
      g_statusLine = "Connected";
      UpdateChartComment();
   }
}

//+------------------------------------------------------------------+
//| Execution reporting (durable queue + ack)                         |
//+------------------------------------------------------------------+
void ReportTradeEvent(const string executionId, const string status, const string eventName,
                      ulong ticket, double price, double remainingVol, double partialVol,
                      double partialPct, const string errorMessage)
{
   EnqueueTradeEvent(executionId, status, eventName, ticket, price,
                     remainingVol, partialVol, partialPct, errorMessage);
}

void ReportExecution(const string executionId, const string status, ulong ticket, double fillPrice, const string errorMessage)
{
   string eventName = status;
   if(status == "filled") eventName = "opened";
   ReportTradeEvent(executionId, status, eventName, ticket, fillPrice, 0, 0, 0, errorMessage);
}

//+------------------------------------------------------------------+
//| Duplicate protection                                              |
//+------------------------------------------------------------------+
bool HasDuplicatePosition(const string signalId, const string executionId, const string symbol, const string comment)
{
   if(FindManagedBySignal(signalId) >= 0) return true;
   if(FindManagedByExecution(executionId) >= 0) return true;

   for(int p = PositionsTotal() - 1; p >= 0; p--)
   {
      ulong t = PositionGetTicket(p);
      if(t == 0) continue;
      if((int)PositionGetInteger(POSITION_MAGIC) != MagicNumber) continue;
      if(PositionGetString(POSITION_SYMBOL) != symbol) continue;
      string pc = PositionGetString(POSITION_COMMENT);
      if(StringLen(executionId) > 0 && StringFind(pc, executionId) >= 0)
         return true;
      if(StringLen(comment) > 0 && pc == comment)
         return true;
      if(StringLen(signalId) > 0 && StringFind(pc, signalId) >= 0)
         return true;
   }
   return false;
}

//+------------------------------------------------------------------+
//| Register / modify / close helpers                                 |
//+------------------------------------------------------------------+
void RegisterManagedTradeFull(const ulong ticket, const string executionId, const string signalId,
                              const string symbol, const bool isBuy,
                              const double entry, const double initialSl,
                              const double tp1, const double tp2, const double tp3,
                              const double volume, const string comment)
{
   int slot = FindManagedSlot();
   if(slot < 0)
   {
      Print("Managed trade table full — ticket ", ticket);
      return;
   }

   g_managed[slot].ticket = ticket;
   g_managed[slot].executionId = executionId;
   g_managed[slot].signalId = signalId;
   g_managed[slot].symbol = symbol;
   g_managed[slot].isBuy = isBuy;
   g_managed[slot].entry = entry;
   g_managed[slot].initialSl = initialSl;
   g_managed[slot].tp1 = tp1;
   g_managed[slot].tp2 = tp2;
   g_managed[slot].tp3 = tp3;
   g_managed[slot].initialVolume = volume;
   g_managed[slot].remainingVolume = volume;
   g_managed[slot].initialR = MathAbs(entry - initialSl);
   g_managed[slot].tp1Hit = false;
   g_managed[slot].tp2Hit = false;
   g_managed[slot].tp3Hit = false;
   g_managed[slot].breakEvenDone = false;
   g_managed[slot].trailArmed = (TrailingStart == TRAIL_START_IMMEDIATE && TrailingMode != TRAIL_DISABLED);
   g_managed[slot].trailReported = false;
   g_managed[slot].magic = MagicNumber;
   g_managed[slot].comment = comment;
   g_managed[slot].pendingOp = "";
   g_managed[slot].retryCount = 0;
   g_managed[slot].nextRetryAt = 0;
   g_managed[slot].lastRetryNote = "";
   g_managed[slot].active = true;

   g_managedDirty = true;
   PersistManagedTrades(true);
   PrintFormat("Registered manage ticket=%I64u sig=%s tp1=%.5f tp2=%.5f tp3=%.5f vol=%.2f",
               ticket, signalId, tp1, tp2, tp3, volume);
}

bool ModifyPositionSl(const ulong ticket, const string symbol, const double newSl, const double tp,
                      const string signalId = "")
{
   MqlTradeRequest request;
   MqlTradeResult result;
   ZeroMemory(request);
   ZeroMemory(result);

   request.action = TRADE_ACTION_SLTP;
   request.position = ticket;
   request.symbol = symbol;
   request.sl = NormalizeDouble(newSl, (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS));
   request.tp = tp > 0 ? NormalizeDouble(tp, (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS)) : 0;

   bool sent = OrderSend(request, result);
   if(!sent || !TradeRetcodeOk(result.retcode))
   {
      int err = GetLastError();
      TxLog("Modify SL", signalId, ticket, "fail",
            StringFormat("err=%d ret=%d", err, result.retcode), 0, "none");
      return false;
   }
   TxLog("Modify SL", signalId, ticket, "ok",
         StringFormat("sl=%.5f ret=%d", request.sl, result.retcode), 0, "none");
   return true;
}

// Sync local remaining from broker without OrderSend (idempotent path).
void SyncRemainingFromBroker(ManagedTrade &mt)
{
   double vol = 0, sl = 0, tp = 0;
   if(ReadBrokerState(mt, vol, sl, tp))
      mt.remainingVolume = vol;
   else
      mt.remainingVolume = 0;
}

bool ClosePartial(ManagedTrade &mt, double volume, const string reason)
{
   if(!PositionSelectByTicket(mt.ticket))
      return false;

   double posVol = PositionGetDouble(POSITION_VOLUME);
   volume = NormalizeVolume(mt.symbol, MathMin(volume, posVol));
   if(volume <= 0) return false;

   // Defense: nothing meaningful left to close on broker
   if(posVol <= VolumeEps(mt.symbol))
   {
      mt.remainingVolume = 0;
      LogBrokerDecision("Partial", mt, "sync",
                        StringFormat("already_flat reason=%s", reason));
      return true;
   }

   LogBrokerDecision("Partial", mt, "execute",
                     StringFormat("vol=%.4f live=%.4f reason=%s", volume, posVol, reason));

   MqlTradeRequest request;
   MqlTradeResult result;
   ZeroMemory(request);
   ZeroMemory(result);

   request.action = TRADE_ACTION_DEAL;
   request.position = mt.ticket;
   request.symbol = mt.symbol;
   request.volume = volume;
   request.deviation = (ulong)MaxSlippagePoints;
   request.magic = MagicNumber;
   request.type_filling = DetectFillingMode(mt.symbol);
   request.comment = reason;

   if(mt.isBuy)
   {
      request.type = ORDER_TYPE_SELL;
      request.price = SymbolInfoDouble(mt.symbol, SYMBOL_BID);
   }
   else
   {
      request.type = ORDER_TYPE_BUY;
      request.price = SymbolInfoDouble(mt.symbol, SYMBOL_ASK);
   }

   bool sent = OrderSend(request, result);
   if(!sent || !TradeRetcodeOk(result.retcode))
   {
      int err = GetLastError();
      TxLog("Partial", mt.signalId, mt.ticket, "fail",
            StringFormat("vol=%.4f err=%d ret=%d", volume, err, result.retcode),
            mt.retryCount, "none");
      return false;
   }

   // Refresh remaining
   if(PositionSelectByTicket(mt.ticket))
      mt.remainingVolume = PositionGetDouble(POSITION_VOLUME);
   else
      mt.remainingVolume = 0;

   TxLog("Partial", mt.signalId, mt.ticket, "ok",
         StringFormat("vol=%.4f rem=%.4f reason=%s", volume, mt.remainingVolume, reason),
         0, "none");
   return true;
}

bool PriceHitTarget(const bool isBuy, const double price, const double target)
{
   if(target <= 0) return false;
   return isBuy ? (price >= target) : (price <= target);
}

void MaybeArmTrail(ManagedTrade &mt)
{
   if(TrailingMode == TRAIL_DISABLED) return;
   if(mt.trailArmed) return;
   if(TrailingStart == TRAIL_START_IMMEDIATE)
      mt.trailArmed = true;
   else if(TrailingStart == TRAIL_START_AFTER_TP1 && mt.tp1Hit)
      mt.trailArmed = true;
   else if(TrailingStart == TRAIL_START_AFTER_TP2 && mt.tp2Hit)
      mt.trailArmed = true;
}

double ComputeTrailSl(ManagedTrade &mt, const double price)
{
   string symbol = mt.symbol;
   bool isBuy = mt.isBuy;
   double dist = 0;

   if(TrailingMode == TRAIL_FIXED_PIPS || TrailingMode == TRAIL_STEP)
      dist = PipsToPrice(symbol, TrailFixedPips > 0 ? TrailFixedPips : 20.0);
   else if(TrailingMode == TRAIL_ATR)
   {
      double atr = GetATR(symbol, TrailATRPeriod > 0 ? TrailATRPeriod : 14);
      dist = atr > 0 ? atr * (TrailATRMult > 0 ? TrailATRMult : 1.5) : PipsToPrice(symbol, 20);
   }
   else if(TrailingMode == TRAIL_SWING_HL || TrailingMode == TRAIL_MARKET_STRUCTURE)
   {
      if(isBuy)
      {
         double sw = SwingLow(symbol, TrailSwingBars > 0 ? TrailSwingBars : 10);
         if(sw > 0) return sw - PipsToPrice(symbol, 1);
         dist = PipsToPrice(symbol, TrailFixedPips > 0 ? TrailFixedPips : 20);
      }
      else
      {
         double sw = SwingHigh(symbol, TrailSwingBars > 0 ? TrailSwingBars : 10);
         if(sw > 0) return sw + PipsToPrice(symbol, 1);
         dist = PipsToPrice(symbol, TrailFixedPips > 0 ? TrailFixedPips : 20);
      }
   }
   else
      return 0;

   return isBuy ? (price - dist) : (price + dist);
}

bool BreakEvenTrigger(ManagedTrade &mt, const double price)
{
   if(BreakEvenMode == BE_DISABLED || mt.breakEvenDone)
      return false;

   if(BreakEvenMode == BE_AT_TP1)
      return mt.tp1Hit || PriceHitTarget(mt.isBuy, price, mt.tp1);

   if(BreakEvenMode == BE_AFTER_X_PIPS)
   {
      double need = PipsToPrice(mt.symbol, BE_XPips > 0 ? BE_XPips : 20);
      return mt.isBuy ? (price >= mt.entry + need) : (price <= mt.entry - need);
   }

   if(BreakEvenMode == BE_AFTER_X_ATR)
   {
      double atr = GetATR(mt.symbol, BE_ATR_Period > 0 ? BE_ATR_Period : 14);
      double need = atr * (BE_XATR > 0 ? BE_XATR : 1.0);
      if(need <= 0) return false;
      return mt.isBuy ? (price >= mt.entry + need) : (price <= mt.entry - need);
   }

   if(BreakEvenMode == BE_AFTER_X_PCT_TARGET)
   {
      double targetDist = MathAbs(mt.tp1 - mt.entry);
      if(targetDist <= 0) targetDist = mt.initialR;
      double need = targetDist * ((BE_XPercentTarget > 0 ? BE_XPercentTarget : 50.0) / 100.0);
      return mt.isBuy ? (price >= mt.entry + need) : (price <= mt.entry - need);
   }
   return false;
}

void ApplyBreakEven(ManagedTrade &mt, const double price)
{
   if(mt.breakEvenDone) return;
   if(mt.pendingOp == "be" && !RetryDue(mt)) return;
   if(StringLen(mt.pendingOp) > 0 && mt.pendingOp != "be") return;
   if(!BreakEvenTrigger(mt, price) && mt.pendingOp != "be")
      return;

   double offset = PipsToPrice(mt.symbol, BeOffsetPips());
   double beSl = mt.isBuy ? (mt.entry + offset) : (mt.entry - offset);
   double currentSl = 0;
   double brokerTp = 0;
   double liveVol = 0;
   if(!ReadBrokerState(mt, liveVol, currentSl, brokerTp))
      return;
   mt.remainingVolume = liveVol;

   // Validate first (safe retries): broker already at/better than desired BE → sync, no modify
   if(ValidateBeAlreadyDone(mt, beSl))
   {
      mt.breakEvenDone = true;
      ClearPendingOp(mt);
      g_managedDirty = true;
      PersistManagedTrades();
      ReportTradeEvent(mt.executionId, "filled", "break_even", mt.ticket, price,
                       mt.remainingVolume, 0, 0, "already_better");
      UpdateChartComment();
      LogBrokerDecision("BE", mt, "sync",
                        StringFormat("sl=%.5f desired=%.5f", currentSl, beSl));
      return;
   }

   LogBrokerDecision("BE", mt, "execute", StringFormat("desired_sl=%.5f", beSl));

   if(ModifyPositionSl(mt.ticket, mt.symbol, beSl, brokerTp, mt.signalId))
   {
      // Order: broker success → flags → persist → report → chart
      mt.breakEvenDone = true;
      ClearPendingOp(mt);
      g_managedDirty = true;
      PersistManagedTrades();
      ReportTradeEvent(mt.executionId, "filled", "break_even", mt.ticket, price,
                       mt.remainingVolume, 0, 0, "");
      UpdateChartComment();
      PrintFormat("Break-even ticket=%I64u SL -> %.5f", mt.ticket, beSl);
      TxLog("BE", mt.signalId, mt.ticket, "ok", StringFormat("sl=%.5f", beSl), 0, "none");
   }
   else
   {
      // Before scheduling retry, re-validate (race: another modify landed)
      if(ValidateBeAlreadyDone(mt, beSl))
      {
         mt.breakEvenDone = true;
         ClearPendingOp(mt);
         SyncRemainingFromBroker(mt);
         g_managedDirty = true;
         PersistManagedTrades();
         ReportTradeEvent(mt.executionId, "filled", "break_even", mt.ticket, price,
                          mt.remainingVolume, 0, 0, "already_better");
         UpdateChartComment();
         LogBrokerDecision("BE", mt, "sync", "post_fail_validate");
         return;
      }
      ScheduleRetry(mt, "be", "modify_rejected");
      UpdateChartComment();
   }
}

void MarkTpComplete(ManagedTrade &mt, const int level)
{
   if(level == 1) mt.tp1Hit = true;
   else if(level == 2) mt.tp2Hit = true;
   else mt.tp3Hit = true;
   MaybeArmTrail(mt);
}

void SyncTpCompleteFromBroker(ManagedTrade &mt, const int level, const double price,
                              const double pct, const string eventName)
{
   SyncRemainingFromBroker(mt);
   MarkTpComplete(mt, level);
   ClearPendingOp(mt);
   string st = (mt.remainingVolume <= VolumeEps(mt.symbol)) ? "closed" : "filled";
   if(mt.remainingVolume <= VolumeEps(mt.symbol))
   {
      mt.remainingVolume = 0;
      mt.active = false;
   }
   g_managedDirty = true;
   PersistManagedTrades();
   ReportTradeEvent(mt.executionId, st, eventName, mt.ticket, price,
                    mt.remainingVolume, 0, pct, "already_done");
   UpdateChartComment();
   string op = (level == 1) ? "TP1" : (level == 2) ? "TP2" : "TP3";
   LogBrokerDecision(op, mt, "sync",
                     StringFormat("vol=%.4f level=%d", mt.remainingVolume, level));
}

void HandleTpHit(ManagedTrade &mt, const int level, const double price)
{
   bool already = (level == 1 && mt.tp1Hit) || (level == 2 && mt.tp2Hit) || (level == 3 && mt.tp3Hit);
   if(already) return;

   string op = (level == 1) ? "tp1" : (level == 2) ? "tp2" : "tp3";
   if(StringLen(mt.pendingOp) > 0 && mt.pendingOp != op) return;
   if(mt.pendingOp == op && !RetryDue(mt)) return;

   double tpLevel = (level == 1) ? mt.tp1 : (level == 2) ? mt.tp2 : mt.tp3;
   if(!PriceHitTarget(mt.isBuy, price, tpLevel) && mt.pendingOp != op)
      return;

   double pct = (level == 1) ? g_tp1Pct : (level == 2) ? g_tp2Pct : g_tp3Pct;
   string eventName = (level == 1) ? "tp1_hit" : (level == 2) ? "tp2_hit" : "tp3_hit";

   // Validate first: live volume / history already reflects this TP → sync, no OrderSend
   // (covers safe retries after reject when broker later completed the partial)
   if(EnablePartialClose || level == 3)
   {
      if(ValidatePartialAlreadyDone(mt, level))
      {
         SyncTpCompleteFromBroker(mt, level, price, pct, eventName);
         return;
      }
   }

   if(!EnablePartialClose)
   {
      // Full close only at TP3 when partials disabled
      if(level == 3)
      {
         SyncRemainingFromBroker(mt);
         double vol = mt.remainingVolume;
         LogBrokerDecision("TP3", mt, "execute", "full_close");
         if(ClosePartial(mt, vol, "TP3-full"))
         {
            MarkTpComplete(mt, 3);
            ClearPendingOp(mt);
            mt.active = false;
            g_managedDirty = true;
            PersistManagedTrades();
            ReportTradeEvent(mt.executionId, "closed", "tp3_hit", mt.ticket, price, 0, vol, 100, "");
            UpdateChartComment();
         }
         else if(ValidatePartialAlreadyDone(mt, 3))
         {
            SyncTpCompleteFromBroker(mt, 3, price, 100, eventName);
         }
         else if(PriceHitTarget(mt.isBuy, price, tpLevel))
         {
            ScheduleRetry(mt, "tp3", "close_rejected");
            UpdateChartComment();
         }
      }
      else
      {
         // No broker op required — mark after decision (notification only)
         MarkTpComplete(mt, level);
         ClearPendingOp(mt);
         g_managedDirty = true;
         PersistManagedTrades();
         ReportTradeEvent(mt.executionId, "filled", eventName, mt.ticket, price,
                          mt.remainingVolume, 0, 0, "partials_disabled");
         UpdateChartComment();
      }
      return;
   }

   SyncRemainingFromBroker(mt);
   double closeVol = NormalizeVolume(mt.symbol, mt.initialVolume * pct / 100.0);
   if(level == 3)
      closeVol = NormalizeVolume(mt.symbol, mt.remainingVolume);
   else if(closeVol >= mt.remainingVolume)
      closeVol = NormalizeVolume(mt.symbol, mt.remainingVolume);

   if(closeVol <= 0)
   {
      MarkTpComplete(mt, level);
      ClearPendingOp(mt);
      g_managedDirty = true;
      PersistManagedTrades();
      ReportTradeEvent(mt.executionId, "filled", eventName, mt.ticket, price,
                       mt.remainingVolume, 0, pct, "volume_too_small");
      UpdateChartComment();
      return;
   }

   LogBrokerDecision((level == 1) ? "TP1" : (level == 2) ? "TP2" : "TP3", mt, "execute",
                     StringFormat("closeVol=%.4f", closeVol));

   if(ClosePartial(mt, closeVol, StringFormat("TP%d", level)))
   {
      // broker success → flags → persist → report → chart
      MarkTpComplete(mt, level);
      ClearPendingOp(mt);
      string st = (mt.remainingVolume <= 0) ? "closed" : "filled";
      if(mt.remainingVolume <= 0)
         mt.active = false;
      g_managedDirty = true;
      PersistManagedTrades();
      ReportTradeEvent(mt.executionId, st, eventName, mt.ticket, price,
                       mt.remainingVolume, closeVol, pct, "");
      ReportTradeEvent(mt.executionId, st, "partial_close", mt.ticket, price,
                       mt.remainingVolume, closeVol, pct, eventName);
      UpdateChartComment();
   }
   else if(ValidatePartialAlreadyDone(mt, level))
   {
      // Reject race: broker state already matches desired — sync instead of retry
      SyncTpCompleteFromBroker(mt, level, price, pct, eventName);
   }
   else if(PriceHitTarget(mt.isBuy, price, tpLevel))
   {
      // Do NOT mark TP complete — retry with backoff while price beyond TP
      // Next retry will Validate first again
      ScheduleRetry(mt, op, "partial_rejected");
      UpdateChartComment();
   }
   else
   {
      ClearPendingOp(mt);
      g_panelExtra = "";
   }
}

void ManageTrailing(ManagedTrade &mt, const double price)
{
   MaybeArmTrail(mt);
   if(!mt.trailArmed || TrailingMode == TRAIL_DISABLED)
      return;

   double currentSl = 0, brokerTp = 0, liveVol = 0;
   if(!ReadBrokerState(mt, liveVol, currentSl, brokerTp))
      return;
   mt.remainingVolume = liveVol;

   double stopsLevel = SymbolInfoInteger(mt.symbol, SYMBOL_TRADE_STOPS_LEVEL) * SymbolInfoDouble(mt.symbol, SYMBOL_POINT);
   double trailSl = ComputeTrailSl(mt, price);
   if(trailSl <= 0) return;

   // Validate: broker SL already same/better than requested trail → skip modify
   if(ValidateTrailAlreadyDone(mt, trailSl))
   {
      if(!mt.trailReported)
      {
         mt.trailReported = true;
         g_managedDirty = true;
         PersistManagedTrades();
         ReportTradeEvent(mt.executionId, "filled", "trailing", mt.ticket, price,
                          mt.remainingVolume, 0, 0, "already_better");
         UpdateChartComment();
         LogBrokerDecision("Trail", mt, "sync",
                           StringFormat("sl=%.5f desired=%.5f", currentSl, trailSl));
      }
      return;
   }

   double step = PipsToPrice(mt.symbol, TrailStepPips > 0 ? TrailStepPips : 1.0);
   bool better = false;

   if(mt.isBuy)
   {
      if((currentSl == 0 || trailSl > currentSl + step) && trailSl < price - stopsLevel)
         better = true;
   }
   else
   {
      if((currentSl == 0 || trailSl < currentSl - step) && trailSl > price + stopsLevel)
         better = true;
   }

   if(!better) return;

   LogBrokerDecision("Trail", mt, "execute", StringFormat("desired_sl=%.5f", trailSl));

   if(ModifyPositionSl(mt.ticket, mt.symbol, trailSl, brokerTp, mt.signalId))
   {
      bool first = !mt.trailReported;
      if(first)
         mt.trailReported = true;
      g_managedDirty = true;
      PersistManagedTrades();
      if(first)
         ReportTradeEvent(mt.executionId, "filled", "trailing", mt.ticket, price,
                          mt.remainingVolume, 0, 0, "");
      UpdateChartComment();
      TxLog("Trail", mt.signalId, mt.ticket, "ok", StringFormat("sl=%.5f", trailSl), 0, "none");
   }
   else
   {
      // Post-fail validate (another path may have moved SL)
      if(ValidateTrailAlreadyDone(mt, trailSl))
      {
         if(!mt.trailReported)
         {
            mt.trailReported = true;
            g_managedDirty = true;
            PersistManagedTrades();
            ReportTradeEvent(mt.executionId, "filled", "trailing", mt.ticket, price,
                             mt.remainingVolume, 0, 0, "already_better");
         }
         LogBrokerDecision("Trail", mt, "sync", "post_fail_validate");
         return;
      }
      TxLog("Trail", mt.signalId, mt.ticket, "fail", "modify_rejected", 0, "none");
   }
}

void ManageOpenPositions()
{
   for(int i = 0; i < MAX_MANAGED; i++)
   {
      if(!g_managed[i].active)
         continue;

      if(!PositionSelectByTicket(g_managed[i].ticket))
      {
         // Position gone — SL or full close
         string closeEv = (g_managed[i].remainingVolume > 0 && !g_managed[i].tp3Hit) ? "sl_hit" : "closed";
         g_managed[i].active = false;
         g_managedDirty = true;
         PersistManagedTrades();
         ReportTradeEvent(g_managed[i].executionId, "closed", closeEv,
                          g_managed[i].ticket, g_managed[i].entry,
                          0, g_managed[i].remainingVolume, 0, "");
         UpdateChartComment();
         continue;
      }

      if((int)PositionGetInteger(POSITION_MAGIC) != MagicNumber &&
         (int)PositionGetInteger(POSITION_MAGIC) != g_managed[i].magic)
         continue;

      string symbol = g_managed[i].symbol;
      bool isBuy = g_managed[i].isBuy;
      double bid = SymbolInfoDouble(symbol, SYMBOL_BID);
      double ask = SymbolInfoDouble(symbol, SYMBOL_ASK);
      double price = isBuy ? bid : ask;

      g_managed[i].remainingVolume = PositionGetDouble(POSITION_VOLUME);

      // Clear broker TP so EA manages targets (set 0 once after open if broker TP was set)
      // Keep SL managed; TP left 0 for local multi-TP.
      double brokerTp = PositionGetDouble(POSITION_TP);
      if(brokerTp != 0 && (g_managed[i].tp2 > 0 || g_managed[i].tp3 > 0 || EnablePartialClose))
      {
         double curSl = PositionGetDouble(POSITION_SL);
         ModifyPositionSl(g_managed[i].ticket, symbol, curSl, 0);
      }

      // TP hits (local)
      if(!g_managed[i].tp1Hit && PriceHitTarget(isBuy, price, g_managed[i].tp1))
         HandleTpHit(g_managed[i], 1, price);
      if(g_managed[i].active && !g_managed[i].tp2Hit && PriceHitTarget(isBuy, price, g_managed[i].tp2))
         HandleTpHit(g_managed[i], 2, price);
      if(g_managed[i].active && !g_managed[i].tp3Hit && PriceHitTarget(isBuy, price, g_managed[i].tp3))
         HandleTpHit(g_managed[i], 3, price);

      if(!g_managed[i].active)
         continue;

      ApplyBreakEven(g_managed[i], price);
      ManageTrailing(g_managed[i], price);
   }
}

//+------------------------------------------------------------------+
//| Execute entry from bridge JSON                                    |
//+------------------------------------------------------------------+
bool ExecuteTradeFromJson(const string tradeJson)
{
   string executionId = JsonGetString(tradeJson, "_id");
   if(StringLen(executionId) == 0)
      executionId = JsonGetString(tradeJson, "id");

   string signalId = JsonGetString(tradeJson, "signalId");
   string rawSymbol = JsonGetString(tradeJson, "mt5Symbol");
   if(StringLen(rawSymbol) == 0)
      rawSymbol = JsonGetString(tradeJson, "symbol");

   string direction = JsonGetString(tradeJson, "direction");
   double lotSize = JsonGetNumber(tradeJson, "lotSize");
   double sl = JsonGetNumber(tradeJson, "stopLoss");
   double tp1 = JsonGetNumber(tradeJson, "takeProfit1");
   double tp2 = JsonGetNumber(tradeJson, "takeProfit2");
   double tp3 = JsonGetNumber(tradeJson, "takeProfit3");
   double risk = JsonGetNumber(tradeJson, "riskPercent");
   if(risk > 0) g_displayRiskPercent = risk;

   string symbol = ResolveBrokerSymbol(rawSymbol);
   if(StringLen(symbol) == 0)
   {
      g_panelExtra = "Unsupported Symbol: " + rawSymbol;
      Print("Unsupported Symbol: ", rawSymbol);
      ReportExecution(executionId, "failed", 0, 0, "Unsupported Symbol: " + rawSymbol);
      UpdateChartComment();
      return false;
   }
   g_panelExtra = "";
   LogBrokerSymbolInfo(symbol);

   string comment = "Kaching#" + executionId;
   if(HasDuplicatePosition(signalId, executionId, symbol, comment))
   {
      Print("Duplicate protection blocked execution ", executionId, " signal ", signalId);
      ReportExecution(executionId, "filled", 0, 0, "duplicate_ignored");
      return false;
   }

   lotSize = NormalizeVolume(symbol, lotSize);
   if(lotSize <= 0)
   {
      ReportExecution(executionId, "failed", 0, 0, "Invalid volume after broker normalize");
      return false;
   }

   MqlTradeRequest request;
   MqlTradeResult result;
   ZeroMemory(request);
   ZeroMemory(result);

   request.action = TRADE_ACTION_DEAL;
   request.symbol = symbol;
   request.volume = lotSize;
   request.deviation = (ulong)MaxSlippagePoints;
   request.magic = MagicNumber;
   request.type_filling = DetectFillingMode(symbol);
   request.sl = sl;
   // ENTRY only: do not attach TP1 as broker TP when multi-TP / partials — EA manages locally
   request.tp = 0;
   request.comment = comment;

   bool isBuy = (direction == "buy");
   if(isBuy)
   {
      request.type = ORDER_TYPE_BUY;
      request.price = SymbolInfoDouble(symbol, SYMBOL_ASK);
   }
   else
   {
      request.type = ORDER_TYPE_SELL;
      request.price = SymbolInfoDouble(symbol, SYMBOL_BID);
   }

   bool sent = OrderSend(request, result);
   if(!sent || !TradeRetcodeOk(result.retcode))
   {
      // Retry alternate filling once
      ENUM_ORDER_TYPE_FILLING alt = request.type_filling;
      if(alt == ORDER_FILLING_IOC) request.type_filling = ORDER_FILLING_FOK;
      else if(alt == ORDER_FILLING_FOK) request.type_filling = ORDER_FILLING_IOC;
      else request.type_filling = ORDER_FILLING_IOC;

      ZeroMemory(result);
      sent = OrderSend(request, result);
      if(!sent || !TradeRetcodeOk(result.retcode))
      {
         int err = GetLastError();
         TxLog("OrderSend", signalId, 0, "fail",
               StringFormat("err=%d ret=%d", err, result.retcode), 1, "none");
         ReportExecution(executionId, "failed", 0, 0, "OrderSend failed");
         return false;
      }
   }

   ulong ticket = result.order;
   if(result.deal > 0 && PositionSelectByTicket(result.order) == false)
   {
      for(int p = PositionsTotal() - 1; p >= 0; p--)
      {
         ulong posTicket = PositionGetTicket(p);
         if(posTicket == 0) continue;
         if((int)PositionGetInteger(POSITION_MAGIC) != MagicNumber) continue;
         if(PositionGetString(POSITION_SYMBOL) != symbol) continue;
         ticket = posTicket;
         break;
      }
   }

   double fillPrice = result.price > 0 ? result.price : request.price;
   double rem = lotSize;
   if(PositionSelectByTicket(ticket))
      rem = PositionGetDouble(POSITION_VOLUME);

   // Order: broker success → register/flags → persist → report → chart
   RegisterManagedTradeFull(
      ticket, executionId, signalId, symbol, isBuy,
      fillPrice, sl, tp1, tp2, tp3, rem, comment
   );
   ReportTradeEvent(executionId, "filled", "opened", ticket, fillPrice, rem, 0, 0, "");
   UpdateChartComment();
   TxLog("OrderSend", signalId, ticket, "ok",
         StringFormat("fill=%.5f vol=%.4f", fillPrice, rem), 0, "none");

   return true;
}

void PollPendingTrades()
{
   string url = EffectiveBackendUrl() + "/api/mt5/bridge/pending";
   string response;
   if(!HttpGet(url, response))
      return;

   int cursor = 0;
   while(true)
   {
      int tradeStart = StringFind(response, "{", cursor);
      if(tradeStart < 0) break;
      int tradeEnd = StringFind(response, "}", tradeStart);
      if(tradeEnd < 0) break;
      string tradeJson = StringSubstr(response, tradeStart, tradeEnd - tradeStart + 1);
      ExecuteTradeFromJson(tradeJson);
      cursor = tradeEnd + 1;
   }
}

//+------------------------------------------------------------------+
int OnInit()
{
   for(int i = 0; i < MAX_MANAGED; i++)
      g_managed[i].active = false;

   if(!ResolvePartialPercents())
   {
      Print("Fix TP1/TP2/TP3_ClosePercent so they sum to 100 (or pick a preset).");
      return INIT_PARAMETERS_INCORRECT;
   }
   g_displayRiskPercent = RiskPercent;

   g_connected = false;
   g_needsRepair = false;
   g_statusLine = "Waiting for Pair Code";
   g_lastError = "";
   RefreshBrokerSnapshot();
   BuildSymbolCache();

   if(LoadCredentials())
   {
      g_connected = true;
      g_statusLine = "Connected";
      Print("KachingTradeCopier v", KACHING_EA_VERSION, " restored saved credentials. Backend: ", g_backendUrl);
   }
   else if(StringLen(PairCode) > 0)
   {
      if(!CompletePairing())
         return INIT_FAILED;
   }
   else
   {
      g_statusLine = "Waiting for Pair Code";
      UpdateChartComment();
      Print("Set PairCode from the dashboard (Auto Trading → Pair MT5).");
      return INIT_PARAMETERS_INCORRECT;
   }

   LoadManagedTrades();
   LoadEventQueue();
   ReconcileManagedTrades("on_init");
   g_managedSnapshot = BuildManagedSnapshot();
   FlushEventQueue();

   EventSetTimer(MathMax(1, PollSeconds));
   SyncAccount();
   SendHeartbeat();
   UpdateChartComment();
   PrintFormat("KachingTradeCopier v%s started. Backend=%s Magic=%d Partials=%s BE=%d Trail=%d/%d Reconcile=%ds",
               KACHING_EA_VERSION, EffectiveBackendUrl(), MagicNumber,
               EnablePartialClose ? "on" : "off",
               (int)BreakEvenMode, (int)TrailingMode, (int)TrailingStart,
               RECONCILE_SECONDS);
   PrintFormat("Broker=%s Server=%s Account=%I64d Mode=%d",
               g_brokerName, g_serverName, g_accountLogin, (int)g_accountMode);
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
   PersistManagedTrades(true);
   PersistEventQueue();
   EventKillTimer();
   Comment("");
}

void OnTimer()
{
   if(g_needsRepair)
   {
      UpdateChartComment();
      return;
   }
   if(!g_connected && StringLen(g_token) == 0)
      return;

   if(TimeCurrent() - g_lastHeartbeat >= HEARTBEAT_SECONDS)
      SendHeartbeat();

   // Periodic Expected-vs-Broker reconcile (does not change poll rate)
   MaybeReconcileManagedTrades("timer_60s", false);

   FlushEventQueue();
   SyncAccount();
   PollPendingTrades();
   ManageOpenPositions();
   UpdateChartComment();
}

void OnTick()
{
   ManageOpenPositions();

   if(g_needsRepair || (!g_connected && StringLen(g_token) == 0))
      return;

   if(TimeCurrent() - lastPoll >= PollSeconds)
   {
      lastPoll = TimeCurrent();
      PollPendingTrades();
   }
}
