import { parseAbi } from 'viem';

// DRAFT. Person A owns IVault and freezes it at kickoff; until then this is the shape the agent assumes. When the real
// interface lands, replace this file with its ABI (or read it from shared/deployments/) and run the agent tests.
// Each signed response travels as (timestamp, data, signature); the vault takes the Airnode and request hash from its
// own storage, never from the caller.
export const vaultAbi = parseAbi([
  'struct SignedResponse { uint256 timestamp; bytes data; bytes signature; }',
  'function openTrigger(uint256 ruleId, address asset, string account, SignedResponse post, SignedResponse p0) returns (uint256 triggerId)',
  'function confirmTrigger(uint256 triggerId, SignedResponse p1) returns (uint256 positionId)',
  'function expireTrigger(uint256 triggerId)',
  'function sell(uint256 positionId, uint8 kind, SignedResponse price) returns (uint256 usdcOut)',
  'event TriggerOpened(uint256 indexed triggerId, uint256 indexed ruleId, address indexed asset, uint256 postId, uint256 p0, uint256 t0)',
  'event TriggerConfirmed(uint256 indexed triggerId, uint256 indexed positionId, uint256 usdcIn, uint256 assetOut, uint256 price)',
  'event TriggerExpired(uint256 indexed triggerId)',
  'event PositionSold(uint256 indexed positionId, uint8 kind, uint256 usdcOut, uint256 price)',
  'error NotSignedByAirnode(address signer)',
  'error WrongRequestHash()',
  'error ResponseTooOld()',
  'error ResponseAlreadyUsed()',
  'error MarketClosed()',
  'error PostAlreadyUsed()',
  'error PostTooOldForPrice()',
  'error PriceBeforePost()',
  'error BeforeMinimumWait()',
  'error WindowClosed()',
  'error WindowStillOpen()',
  'error TrendBelowThreshold()',
  'error AboveSpikeCap()',
  'error RulePaused()',
  'error NotRuleAgent()',
  'error AssetNotAllowed()',
  'error AccountNotWatched()',
  'error CooldownActive()',
  'error DailyLimitReached()',
  'error TriggerNotPending()',
  'error PositionNotOpen()',
  'error SellConditionNotMet()',
]);

// The order of IVault's sell kind enum in the draft
export const SELL_KINDS = ['manual', 'take-profit', 'stagnation', 'stop-loss'] as const;
