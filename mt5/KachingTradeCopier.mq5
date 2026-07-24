//+------------------------------------------------------------------+
//|                                         KachingTradeCopier.mq5   |
//|                        KachingScanner Telegram Trade Copier EA   |
//|                                                                  |
//| Trade management (Pro+ when flags are set on pending payload):   |
//|  - Break-even: when price reaches breakEvenTriggerR × initial R  |
//|    (entry→SL distance), move SL to entry ± breakEvenOffsetPips.  |
//|  - Trailing stop: after fill, trail SL by trailDistancePips from |
//|    price; only tighten when improvement ≥ trailStepPips.         |
//| Defaults come from the bridge JSON (backend sets SL-distance     |
//| trail, 20% step, 1R BE trigger, 2-pip BE offset).                |
//+------------------------------------------------------------------+
#property copyright "KachingScanner"
#property version   "1.11"
#property strict

input string BackendURL = "http://localhost:4000";
input string LinkToken  = "";
// Default 1s for lower copy latency; raise if broker/WebRequest rate-limits. Recompile after change.
input int    PollSeconds = 1;
input int    MagicNumber = 88001;
input double MaxSlippagePoints = 30;

#define MAX_MANAGED 64

struct ManagedTrade
{
   ulong  ticket;
   string symbol;
   bool   isBuy;
   double entry;
   double initialSl;
   double initialR;          // |entry - initialSl|
   bool   trailingStop;
   bool   breakEven;
   double trailDistance;     // price units
   double trailStep;         // price units
   double breakEvenTriggerR;
   double breakEvenOffset;   // price units
   bool   breakEvenDone;
   bool   active;
};

ManagedTrade g_managed[MAX_MANAGED];
datetime lastPoll = 0;

bool HttpGet(const string url, string &response)
{
   char data[];
   char result[];
   string headers = "X-MT5-Token: " + LinkToken + "\r\n";
   int timeout = 10000;
   ResetLastError();
   int code = WebRequest("GET", url, headers, timeout, data, result, headers);
   if(code == -1)
   {
      Print("WebRequest failed. Allow URL in Tools -> Options -> Expert Advisors: ", url);
      return false;
   }
   response = CharArrayToString(result);
   return true;
}

bool HttpPostJson(const string url, const string body, string &response)
{
   char data[];
   char result[];
   StringToCharArray(body, data, 0, WHOLE_ARRAY, CP_UTF8);
   ArrayResize(data, StringLen(body));
   string headers = "Content-Type: application/json\r\nX-MT5-Token: " + LinkToken + "\r\n";
   int timeout = 10000;
   ResetLastError();
   int code = WebRequest("POST", url, headers, timeout, data, result, headers);
   if(code == -1)
   {
      Print("WebRequest POST failed: ", url);
      return false;
   }
   response = CharArrayToString(result);
   return true;
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

void SyncAccount()
{
   string url = BackendURL + "/api/mt5/bridge/sync";
   string body = StringFormat(
      "{\"balance\":%.2f,\"currency\":\"%s\",\"terminalId\":\"%d\"}",
      AccountInfoDouble(ACCOUNT_BALANCE),
      AccountInfoString(ACCOUNT_CURRENCY),
      TerminalInfoInteger(TERMINAL_BUILD)
   );
   string response;
   HttpPostJson(url, body, response);
}

void ReportExecution(const string executionId, const string status, ulong ticket, double fillPrice, const string errorMessage)
{
   string url = BackendURL + "/api/mt5/bridge/report";
   string err = errorMessage;
   StringReplace(err, "\"", "'");
   string body = StringFormat(
      "{\"executionId\":\"%s\",\"status\":\"%s\",\"ticket\":\"%I64u\",\"fillPrice\":%.5f,\"balance\":%.2f,\"currency\":\"%s\",\"error\":\"%s\"}",
      executionId,
      status,
      ticket,
      fillPrice,
      AccountInfoDouble(ACCOUNT_BALANCE),
      AccountInfoString(ACCOUNT_CURRENCY),
      err
   );
   string response;
   HttpPostJson(url, body, response);
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
   string url = BackendURL + "/api/mt5/bridge/pending";
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
   if(StringLen(LinkToken) == 0)
   {
      Print("Set LinkToken from the KachingScanner dashboard.");
      return INIT_PARAMETERS_INCORRECT;
   }

   for(int i = 0; i < MAX_MANAGED; i++)
      g_managed[i].active = false;

   EventSetTimer(PollSeconds);
   SyncAccount();
   Print("KachingTradeCopier v1.10 started. Backend: ", BackendURL);
   Print("Trail + break-even managed on OnTick for MagicNumber=", MagicNumber);
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
   EventKillTimer();
}

void OnTimer()
{
   SyncAccount();
   PollPendingTrades();
   ManageOpenPositions();
}

void OnTick()
{
   ManageOpenPositions();

   if(TimeCurrent() - lastPoll >= PollSeconds)
   {
      lastPoll = TimeCurrent();
      PollPendingTrades();
   }
}
