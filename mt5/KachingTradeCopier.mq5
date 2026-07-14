//+------------------------------------------------------------------+
//|                                         KachingTradeCopier.mq5   |
//|                        KachingScanner Telegram Trade Copier EA   |
//+------------------------------------------------------------------+
#property copyright "KachingScanner"
#property version   "1.00"
#property strict

input string BackendURL = "http://localhost:4000";
input string LinkToken  = "";
input int    PollSeconds = 3;
input int    MagicNumber = 88001;
input double MaxSlippagePoints = 30;

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

   if(direction == "buy")
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

   ReportExecution(executionId, "filled", result.order, result.price, "");
   return true;
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
   EventSetTimer(PollSeconds);
   SyncAccount();
   Print("KachingTradeCopier started. Backend: ", BackendURL);
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
}

void OnTick()
{
   if(TimeCurrent() - lastPoll >= PollSeconds)
   {
      lastPoll = TimeCurrent();
      PollPendingTrades();
   }
}
