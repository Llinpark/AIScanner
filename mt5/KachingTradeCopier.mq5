//+------------------------------------------------------------------+
//|                                         KachingTradeCopier.mq5   |
//|                        KachingScanner Telegram Trade Copier EA   |
//|                                                                  |
//| Auth (v1.14+):                                                   |
//|  1) Saved device credentials (access + refresh) auto-reconnect   |
//|  2) PairCode → POST /api/mt5/pair/complete                       |
//|     (uses built-in default backend URL for bootstrap only)       |
//|                                                                  |
//| Trade management (Pro+ when flags are set on pending payload):   |
//|  - Break-even / Trailing stop managed on tick + timer            |
//+------------------------------------------------------------------+
#property copyright "KachingScanner"
#property version   "1.14"
#property strict

// Primary inputs
input string PairCode   = "";          // 8-char Pair Code from dashboard (one-time)
input int    PollSeconds = 1;          // Bridge poll interval (seconds)
input int    MagicNumber = 88001;
input double RiskPercent = 1.0;        // Chart display reference (lot sizing from dashboard)
input double MaxSlippagePoints = 30;

#define KACHING_DEFAULT_BACKEND "https://api.kachingscanner.com"
#define KACHING_EA_VERSION "1.14"
#define CRED_FILE "KachingAI_credentials.txt"
#define HEARTBEAT_SECONDS 30
#define MAX_MANAGED 64

struct ManagedTrade
{
   ulong  ticket;
   string symbol;
   bool   isBuy;
   double entry;
   double initialSl;
   double initialR;
   bool   trailingStop;
   bool   breakEven;
   double trailDistance;
   double trailStep;
   double breakEvenTriggerR;
   double breakEvenOffset;
   bool   breakEvenDone;
   bool   active;
};

ManagedTrade g_managed[MAX_MANAGED];
datetime lastPoll = 0;
datetime g_lastHeartbeat = 0;

string g_backendUrl = "";
string g_token = "";
string g_refreshToken = "";
string g_deviceId = "";
string g_subscriberId = "";
string g_accessExpiresAt = "";
string g_statusLine = "Waiting for Pair Code";
string g_lastError = "";
datetime g_lastSyncAt = 0;
bool   g_connected = false;
bool   g_needsRepair = false;

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

void UpdateChartComment()
{
   string broker = AccountInfoString(ACCOUNT_COMPANY);
   if(StringLen(broker) == 0)
      broker = AccountInfoString(ACCOUNT_SERVER);
   long account = AccountInfoInteger(ACCOUNT_LOGIN);
   double balance = AccountInfoDouble(ACCOUNT_BALANCE);
   string syncStr = g_lastSyncAt > 0 ? TimeToString(g_lastSyncAt, TIME_DATE|TIME_SECONDS) : "—";

   string text;
   if(g_needsRepair)
      text = "Kaching AI\nStatus: Connection Lost\nPlease Pair Again";
   else if(!g_connected)
      text = StringFormat("Kaching AI\nStatus: %s\n%s", g_statusLine,
         StringLen(g_lastError) > 0 ? g_lastError : "Enter PairCode from dashboard");
   else
      text = StringFormat(
         "Kaching AI\nStatus: Connected\nBroker: %s\nAccount: %I64d\nBalance: %.2f %s\nRisk: %.2f%%\nLast Sync: %s",
         broker, account, balance, AccountInfoString(ACCOUNT_CURRENCY), RiskPercent, syncStr);
   Comment(text);
}

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

bool HttpPostJsonAuth(const string url, const string body, string &response)
{
   if(!EnsureAccessToken()) return false;
   int code = HttpRequestRaw("POST", url, body, true, response);
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
         code = HttpRequestRaw("POST", url, body, true, response);
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
      "{\"balance\":%.2f,\"currency\":\"%s\",\"broker\":\"%s\",\"accountNumber\":\"%I64d\",\"deviceId\":\"%s\"}",
      AccountInfoDouble(ACCOUNT_BALANCE),
      AccountInfoString(ACCOUNT_CURRENCY),
      broker,
      AccountInfoInteger(ACCOUNT_LOGIN),
      g_deviceId
   );
   string response;
   if(HttpPostJsonAuth(url, body, response))
   {
      g_lastHeartbeat = TimeCurrent();
      g_lastSyncAt = TimeCurrent();
      g_connected = true;
      g_statusLine = "Connected";
      UpdateChartComment();
   }
}

void SyncAccount()
{
   string url = EffectiveBackendUrl() + "/api/mt5/bridge/sync";
   string body = StringFormat(
      "{\"balance\":%.2f,\"currency\":\"%s\",\"terminalId\":\"%d\",\"accountNumber\":\"%I64d\"}",
      AccountInfoDouble(ACCOUNT_BALANCE),
      AccountInfoString(ACCOUNT_CURRENCY),
      TerminalInfoInteger(TERMINAL_BUILD),
      AccountInfoInteger(ACCOUNT_LOGIN)
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

void ReportExecution(const string executionId, const string status, ulong ticket, double fillPrice, const string errorMessage)
{
   string url = EffectiveBackendUrl() + "/api/mt5/bridge/report";
   string err = errorMessage;
   StringReplace(err, "\"", "'");
   string body = StringFormat(
      "{\"executionId\":\"%s\",\"status\":\"%s\",\"ticket\":\"%I64u\",\"fillPrice\":%.5f,\"balance\":%.2f,\"currency\":\"%s\",\"error\":\"%s\"}",
      executionId, status, ticket, fillPrice,
      AccountInfoDouble(ACCOUNT_BALANCE),
      AccountInfoString(ACCOUNT_CURRENCY),
      err
   );
   string response;
   HttpPostJsonAuth(url, body, response);
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

void RegisterManagedTrade(const ulong ticket, const string symbol, const bool isBuy,
                          const double entry, const double initialSl,
                          const bool trailingStop, const bool breakEven,
                          const double trailDistancePips, const double trailStepPips,
                          const double breakEvenTriggerR, const double breakEvenOffsetPips)
{
   if(!trailingStop && !breakEven)
      return;

   int slot = FindManagedSlot();
   if(slot < 0)
   {
      Print("Managed trade table full — trail/BE skipped for ticket ", ticket);
      return;
   }

   double pip = PipSize(symbol);
   double trailDist = trailDistancePips > 0 ? PipsToPrice(symbol, trailDistancePips) : MathAbs(entry - initialSl);
   if(trailDist <= 0)
      trailDist = pip * 20;
   double trailStep = trailStepPips > 0 ? PipsToPrice(symbol, trailStepPips) : trailDist * 0.2;
   if(trailStep <= 0)
      trailStep = pip;

   g_managed[slot].ticket = ticket;
   g_managed[slot].symbol = symbol;
   g_managed[slot].isBuy = isBuy;
   g_managed[slot].entry = entry;
   g_managed[slot].initialSl = initialSl;
   g_managed[slot].initialR = MathAbs(entry - initialSl);
   if(g_managed[slot].initialR <= 0)
      g_managed[slot].initialR = trailDist;
   g_managed[slot].trailingStop = trailingStop;
   g_managed[slot].breakEven = breakEven;
   g_managed[slot].trailDistance = trailDist;
   g_managed[slot].trailStep = trailStep;
   g_managed[slot].breakEvenTriggerR = breakEvenTriggerR > 0 ? breakEvenTriggerR : 1.0;
   g_managed[slot].breakEvenOffset = breakEvenOffsetPips > 0 ? PipsToPrice(symbol, breakEvenOffsetPips) : PipsToPrice(symbol, 2);
   g_managed[slot].breakEvenDone = false;
   g_managed[slot].active = true;

   PrintFormat("Registered manage ticket=%I64u trail=%s be=%s dist=%.5f step=%.5f triggerR=%.2f",
               ticket,
               trailingStop ? "on" : "off",
               breakEven ? "on" : "off",
               g_managed[slot].trailDistance,
               g_managed[slot].trailStep,
               g_managed[slot].breakEvenTriggerR);
}

bool ModifyPositionSl(const ulong ticket, const string symbol, const double newSl, const double tp)
{
   MqlTradeRequest request;
   MqlTradeResult result;
   ZeroMemory(request);
   ZeroMemory(result);

   request.action = TRADE_ACTION_SLTP;
   request.position = ticket;
   request.symbol = symbol;
   request.sl = NormalizeDouble(newSl, (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS));
   request.tp = tp;

   if(!OrderSend(request, result))
   {
      Print("SL modify failed ticket=", ticket, " err=", GetLastError(), " retcode=", result.retcode);
      return false;
   }
   return true;
}

void ManageOpenPositions()
{
   for(int i = 0; i < MAX_MANAGED; i++)
   {
      if(!g_managed[i].active)
         continue;

      if(!PositionSelectByTicket(g_managed[i].ticket))
      {
         g_managed[i].active = false;
         continue;
      }

      if((int)PositionGetInteger(POSITION_MAGIC) != MagicNumber)
         continue;

      string symbol = g_managed[i].symbol;
      bool isBuy = g_managed[i].isBuy;
      double entry = g_managed[i].entry;
      double currentSl = PositionGetDouble(POSITION_SL);
      double tp = PositionGetDouble(POSITION_TP);
      double bid = SymbolInfoDouble(symbol, SYMBOL_BID);
      double ask = SymbolInfoDouble(symbol, SYMBOL_ASK);
      double price = isBuy ? bid : ask;
      double stopsLevel = SymbolInfoInteger(symbol, SYMBOL_TRADE_STOPS_LEVEL) * SymbolInfoDouble(symbol, SYMBOL_POINT);
      bool changed = false;
      double newSl = currentSl;

      // --- Break-even: lock entry (+offset) once price reaches N×R ---
      if(g_managed[i].breakEven && !g_managed[i].breakEvenDone && g_managed[i].initialR > 0)
      {
         double triggerMove = g_managed[i].initialR * g_managed[i].breakEvenTriggerR;
         bool triggered = isBuy
            ? (price >= entry + triggerMove)
            : (price <= entry - triggerMove);

         if(triggered)
         {
            double beSl = isBuy
               ? entry + g_managed[i].breakEvenOffset
               : entry - g_managed[i].breakEvenOffset;

            bool improves = isBuy
               ? (currentSl < beSl || currentSl == 0)
               : (currentSl > beSl || currentSl == 0);

            if(improves)
            {
               newSl = beSl;
               changed = true;
               g_managed[i].breakEvenDone = true;
               PrintFormat("Break-even ticket=%I64u SL -> %.5f", g_managed[i].ticket, beSl);
            }
            else
            {
               g_managed[i].breakEvenDone = true;
            }
         }
      }

      // --- Trailing stop: keep SL trailDistance behind price ---
      if(g_managed[i].trailingStop)
      {
         double trailSl = isBuy
            ? price - g_managed[i].trailDistance
            : price + g_managed[i].trailDistance;

         double candidate = changed ? newSl : currentSl;
         bool better = false;
         if(isBuy)
         {
            if(candidate == 0 || trailSl > candidate + g_managed[i].trailStep)
            {
               if(trailSl < price - stopsLevel)
               {
                  newSl = trailSl;
                  better = true;
               }
            }
         }
         else
         {
            if(candidate == 0 || trailSl < candidate - g_managed[i].trailStep)
            {
               if(trailSl > price + stopsLevel)
               {
                  newSl = trailSl;
                  better = true;
               }
            }
         }

         if(better)
            changed = true;
      }

      if(changed && newSl != currentSl)
         ModifyPositionSl(g_managed[i].ticket, symbol, newSl, tp);
   }
}

bool ExecuteTradeFromJson(const string tradeJson)
{
   string executionId = JsonGetString(tradeJson, "_id");
   if(StringLen(executionId) == 0)
      executionId = JsonGetString(tradeJson, "id");

   string symbol = JsonGetString(tradeJson, "mt5Symbol");
   if(StringLen(symbol) == 0)
      symbol = JsonGetString(tradeJson, "symbol");

   string direction = JsonGetString(tradeJson, "direction");
   double lotSize = JsonGetNumber(tradeJson, "lotSize");
   double sl = JsonGetNumber(tradeJson, "stopLoss");
   double tp = JsonGetNumber(tradeJson, "takeProfit1");

   bool trailingStop = JsonGetBool(tradeJson, "trailingStop");
   bool breakEven = JsonGetBool(tradeJson, "breakEven");
   double trailDistancePips = JsonGetNumber(tradeJson, "trailDistancePips");
   double trailStepPips = JsonGetNumber(tradeJson, "trailStepPips");
   double breakEvenTriggerR = JsonGetNumber(tradeJson, "breakEvenTriggerR");
   double breakEvenOffsetPips = JsonGetNumber(tradeJson, "breakEvenOffsetPips");

   if(!SymbolSelect(symbol, true))
   {
      Print("Symbol not found in Market Watch: ", symbol);
      ReportExecution(executionId, "failed", 0, 0, "Symbol not found: " + symbol);
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
   request.type_filling = ORDER_FILLING_FOK;
   request.sl = sl;
   request.tp = tp;
   request.comment = "Kaching#" + executionId;

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

   if(!OrderSend(request, result))
   {
      Print("OrderSend failed: ", GetLastError());
      ReportExecution(executionId, "failed", 0, 0, "OrderSend failed");
      return false;
   }

   ulong ticket = result.order;
   if(result.deal > 0 && PositionSelectByTicket(result.order) == false)
   {
      // Some brokers return deal id; resolve position by magic+symbol shortly after fill.
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
   ReportExecution(executionId, "filled", ticket, fillPrice, "");

   RegisterManagedTrade(
      ticket,
      symbol,
      isBuy,
      fillPrice,
      sl,
      trailingStop,
      breakEven,
      trailDistancePips,
      trailStepPips,
      breakEvenTriggerR > 0 ? breakEvenTriggerR : 1.0,
      breakEvenOffsetPips > 0 ? breakEvenOffsetPips : 2.0
   );

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


int OnInit()
{
   for(int i = 0; i < MAX_MANAGED; i++)
      g_managed[i].active = false;

   g_connected = false;
   g_needsRepair = false;
   g_statusLine = "Waiting for Pair Code";
   g_lastError = "";

   if(LoadCredentials())
   {
      g_connected = true;
      g_statusLine = "Connected";
      Print("KachingTradeCopier v1.14 restored saved credentials. Backend: ", g_backendUrl);
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

   EventSetTimer(MathMax(1, PollSeconds));
   SyncAccount();
   SendHeartbeat();
   UpdateChartComment();
   Print("KachingTradeCopier v1.14 started. Backend: ", EffectiveBackendUrl());
   Print("Trail + break-even managed on OnTick for MagicNumber=", MagicNumber);
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
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
