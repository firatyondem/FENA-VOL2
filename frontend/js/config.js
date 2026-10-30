// ===== Static configuration, taken from the feature spec =====
// Times are in minutes, percentages are plain numbers (3 = 3%).

// Asset profiles (spec "Asset profiles"). Users can make these stricter, never looser.
// mockPrice is only used in mock mode, before the contracts exist.
const ASSETS = {
  ETH:  { token: "tETH",  label: "Ether",           hours: "24/7",           trend: 3,   spike: 12, minWait: 30, maxWindow: 240, mockPrice: 3400 },
  BTC:  { token: "tBTC",  label: "Bitcoin",         hours: "24/7",           trend: 3,   spike: 12, minWait: 30, maxWindow: 240, mockPrice: 98000 },
  // DOGE has no profile in the spec yet ("needs wider limits than ETH"). Team to confirm.
  DOGE: { token: "tDOGE", label: "Dogecoin",        hours: "24/7",           trend: 5,   spike: 20, minWait: 30, maxWindow: 240, mockPrice: 0.21, draft: true },
  TSLA: { token: "tTSLA", label: "Tesla",           hours: "Exchange hours", trend: 2,   spike: 8,  minWait: 60, maxWindow: 390, mockPrice: 420 },
  OIL:  { token: "tOIL",  label: "Crude oil (WTI)", hours: "~24/5",          trend: 1.5, spike: 5,  minWait: 60, maxWindow: 360, mockPrice: 72 },
};

// Selling defaults (spec "Selling"): take profit, stagnation exit after Z hours within ±Y%
const SELL_DEFAULTS = { takeProfit: 8, stagnationHours: 24, stagnationBand: 1 };

// Spending limits (spec "Rule builder")
const LIMIT_DEFAULTS = { maxPerTradePct: 5, dailyPct: 20, cooldownHours: 24 };

// "Demo rules use short times (e.g. 2 min -> 10 min) so the trade completes on stage."
const DEMO_TIMING = { minWait: 2, maxWindow: 10, cooldownHours: 0 };

// Watched accounts and the assets each one may trigger (spec "Account -> investment areas")
const ACCOUNTS = [
  { handle: "realDonaldTrump", name: "Donald Trump", role: "President",            assets: ["OIL", "BTC", "ETH"] },
  { handle: "elonmusk",        name: "Elon Musk",    role: "Tesla / X owner",      assets: ["DOGE", "TSLA"] },
  { handle: "JDVance",         name: "JD Vance",     role: "Vice President",       assets: ["BTC", "OIL"] },
  { handle: "marcorubio",      name: "Marco Rubio",  role: "Secretary of State",   assets: ["OIL"] },
];

// Suggested topics per asset (spec "Topic -> asset map"). Users can edit them.
const TOPICS = {
  OIL:  ["Venezuela", "Iran", "Strait of Hormuz", "Saudi Arabia / OPEC", "Russia sanctions", "Middle East conflict", "drilling and pipelines", "strategic petroleum reserve", "energy tariffs"],
  ETH:  ["crypto reserve", "SEC and crypto rules", "stablecoin laws", "Fed and interest rates", "Ethereum"],
  BTC:  ["crypto reserve", "SEC and crypto rules", "stablecoin laws", "Fed and interest rates", "Bitcoin"],
  DOGE: ["Dogecoin", "DOGE memes"],
  TSLA: ["Tesla", "EV tax credits", "auto tariffs on China", "self-driving rules", "Musk-Trump disputes"],
};

// Fill these in once the contracts are deployed (spec: Base Sepolia is the likely testnet)
const CHAIN = {
  network: "Base Sepolia",
  vaultAddress: "",   // TODO: deployed vault contract
  usdcAddress: "",    // TODO: mock USDC token
};
