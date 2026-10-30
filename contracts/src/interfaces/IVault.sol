// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title A vault that buys after a relevant post, but only when a signed price trend confirms it
/// @notice One contract holds every user's funds, with a balance and one rule per user. The user's agent wallet opens a
/// trigger with a signed post and a signed price P0 (Gate 1). Anyone can confirm it with a later signed price P1, and
/// the vault buys only if P1 passes the trend, spike, timing, market-hours and spending checks of the rule (Gate 2).
/// Positions sell at a signed price, by hand or when take-profit or a stagnation exit applies.
/// @dev Units: percentages in basis points (10_000 = 100%), durations and times in seconds, prices with 18 decimals,
/// amounts in token units. Every signed response must come from the request whose hash the vault stores: a price
/// projection has the fields "price" and "updatedAt", and a post projection has the field "id" with the tweet ID.
/// A response is accepted for at most 5 minutes after the Airnode signed it (ResponseTooOld). Each P0 and P1 is recorded
/// per user under keccak256(abi.encode(requestHash, timestamp, data)): it cannot open or confirm a second trigger of the
/// same user (ResponseAlreadyUsed), but the same signed price can serve triggers of different users. Sell prices are not
/// recorded, so one price can sell several positions; each position sells once.
interface IVault {
    /// @notice A response that an Airnode v2 signed, as the starter's fetch-response prints it
    /// @dev `data` is the signed JSON string as bytes, sent as it is, without parsing it and writing it again. The vault
    /// compares `requestHash` with the hash it stores before it verifies the signature over the stored hash.
    struct SignedResponse {
        bytes32 requestHash;
        uint256 timestamp;
        bytes data;
        bytes signature;
    }

    /// @notice Limits that the admin sets for an asset. A user's rule can be stricter, never looser.
    struct AssetProfile {
        // Mock token that the vault buys, such as tETH
        address token;
        // Address that signs the asset's price responses
        address airnode;
        // Hash of the price request: operation, parameters and projection
        bytes32 priceRequestHash;
        // Lowest trend threshold that a rule may set
        uint16 minThresholdBps;
        // Highest spike cap that a rule may set
        uint16 maxSpikeCapBps;
        // Shortest wait between P0 and P1 that a rule may set
        uint32 minWait;
        // Longest window between P0 and P1 that a rule may set
        uint32 maxWindow;
        // Longest time from the source taking a price to the vault using it. A closed market's price goes stale, so this
        // check keeps the vault from trading while the market is closed.
        uint32 maxPriceAge;
        // Whether "updatedAt" is in milliseconds, as Nodary writes it, instead of seconds
        bool updatedAtInMs;
    }

    /// @notice The part of a user's rule that holds for every asset
    struct Rule {
        // The only wallet that may open triggers for the user
        address agent;
        // Quote tokens that one buy spends
        uint256 buyAmount;
        // Largest single buy
        uint256 maxPerTrade;
        // Most quote tokens spent per UTC day, split across the assets by their budget shares
        uint256 dailyLimit;
    }

    /// @notice The part of a user's rule for one asset that the rule may buy
    struct AssetRule {
        // Gate 2 buys only if P1 >= P0 * (1 + threshold)
        uint16 thresholdBps;
        // Gate 2 buys only if P1 <= P0 * (1 + spike cap)
        uint16 spikeCapBps;
        // Shortest time from P0 to P1
        uint32 minWait;
        // Longest time from P0 to P1, after which the trigger expires
        uint32 maxWindow;
        // Shortest time between two buys of the asset
        uint32 cooldown;
        // Share of the daily limit that the asset can spend. The shares of a rule add up to at most 10_000.
        uint16 budgetShareBps;
        // Anyone can sell a position when P >= entry * (1 + take-profit). 0 turns take-profit off.
        uint16 takeProfitBps;
        // Anyone can sell a position that is still within entry * (1 +- band) after the stagnation delay
        uint16 stagnationBandBps;
        // Time after the buy before the stagnation exit applies. 0 turns the stagnation exit off.
        uint32 stagnationDelay;
    }

    enum TriggerStatus {
        None,
        Open,
        Confirmed,
        Expired
    }

    /// @notice A relevant post with its verified P0, waiting for a P1 that confirms the trend
    struct Trigger {
        address user;
        bytes32 assetId;
        // Account request hash of the post
        bytes32 account;
        uint256 tweetId;
        uint256 p0;
        // Time at which the source took P0
        uint256 t0;
        TriggerStatus status;
    }

    /// @notice Asset tokens that the vault bought for a user and holds until they sell
    struct Position {
        address user;
        bytes32 assetId;
        // Asset tokens held
        uint256 amount;
        // Quote tokens spent
        uint256 cost;
        // P1 of the trigger that bought the position
        uint256 entryPrice;
        uint256 openedAt;
        bool isOpen;
    }

    enum SellReason {
        Manual,
        TakeProfit,
        Stagnation
    }

    event AssetProfileSet(bytes32 indexed assetId, AssetProfile profile);
    event WatchableAccountSet(bytes32 indexed account, address airnode);
    event Deposited(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event RuleSet(
        address indexed user,
        Rule rule,
        bytes32[] assetIds,
        AssetRule[] assetRules,
        string[] assetTopics,
        bytes32[] watchedAccounts
    );
    event PausedSet(address indexed user, bool isPaused);
    event TriggerOpened(
        uint256 indexed triggerId,
        address indexed user,
        bytes32 indexed assetId,
        uint256 tweetId,
        uint256 p0,
        uint256 t0
    );
    event TriggerConfirmed(
        uint256 indexed triggerId, uint256 indexed positionId, uint256 p1, uint256 t1, uint256 quoteIn, uint256 assetOut
    );
    event TriggerExpired(uint256 indexed triggerId);
    event PositionSold(
        uint256 indexed positionId, address indexed user, SellReason reason, uint256 price, uint256 quoteOut
    );

    // Signed data. A response that the expected Airnode did not sign reverts with
    // AirnodeV2Attestation.NotSignedByAirnode.
    error WrongRequestHash(bytes32 expected, bytes32 actual);
    error ResponseTooOld(uint256 responseTimestamp);
    error PriceTooOld(uint256 priceTimestamp);
    error ResponseAlreadyUsed(bytes32 responseHash);

    // Assets, accounts and rules
    error AssetNotRegistered(bytes32 assetId);
    error AccountNotRegistered(bytes32 account);
    error AssetNotAllowed(address user, bytes32 assetId);
    error AccountNotWatched(address user, bytes32 account);
    error RuleLooserThanProfile(bytes32 assetId);
    error InvalidRule();
    error RuleIsPaused(address user);
    error ZeroAmount();
    error InsufficientBalance(uint256 balance, uint256 needed);

    // Gate 1
    error NotAgent(address caller);
    error TweetAlreadyUsed(address user, bytes32 assetId, uint256 tweetId);
    error PriceOutsideTweetWindow(uint256 tweetTime, uint256 priceTime);

    // Gate 2
    error TriggerNotOpen(uint256 triggerId);
    error WaitNotOver(uint256 earliest);
    error WindowClosed(uint256 deadline);
    error WindowNotClosed(uint256 deadline);
    error TrendTooWeak(uint256 p0, uint256 p1);
    error SpikeTooHigh(uint256 p0, uint256 p1);
    error CooldownActive(uint256 until);
    error PerTradeLimitExceeded(uint256 amount, uint256 limit);
    error DailyBudgetExceeded(uint256 amount, uint256 remaining);

    // Selling
    error PositionNotOpen(uint256 positionId);
    error NotPositionOwner(address caller);
    error PriceBeforeBuy(uint256 priceTime, uint256 openedAt);
    error TakeProfitNotReached(uint256 price, uint256 target);
    error StagnationDelayNotOver(uint256 earliest);
    error PriceOutsideStagnationBand(uint256 price, uint256 entryPrice);

    /// @notice Sets the limits of an asset. Only the admin can call this.
    function setAssetProfile(bytes32 assetId, AssetProfile calldata profile) external;

    /// @notice Lets rules watch the account whose posts the request with hash `account` reads. Only the admin can call
    /// this.
    /// @dev The request fixes the account and whether item 0 or item 1 of its last posts is read, for an account with a
    /// pinned post. `airnode` is the address that signs the responses; the zero address removes the account.
    function setWatchableAccount(bytes32 account, address airnode) external;

    /// @notice Moves `amount` quote tokens from the caller into the caller's balance in the vault
    function deposit(uint256 amount) external;

    /// @notice Moves `amount` quote tokens from the caller's balance in the vault to the caller, even while paused
    function withdraw(uint256 amount) external;

    /// @notice Replaces the caller's rule
    /// @param assetIds Assets that the rule may buy, in the user's priority order
    /// @param assetRules The rule for each asset in `assetIds`
    /// @param assetTopics For each asset in `assetIds`, the comma-separated topic keywords that the agent checks posts
    /// against at Gate 1. RuleSet emits them, and the vault does not store them, so the agent reads the latest RuleSet.
    /// @param watchedAccounts Account request hashes whose posts can open triggers
    function setRule(
        Rule calldata rule,
        bytes32[] calldata assetIds,
        AssetRule[] calldata assetRules,
        string[] calldata assetTopics,
        bytes32[] calldata watchedAccounts
    ) external;

    /// @notice Pauses or resumes the caller's rule. While paused, no trigger opens or confirms and only manual sells go
    /// through.
    function setPaused(bool isPaused) external;

    /// @notice Gate 1: opens a trigger for a relevant post. Only the user's agent wallet can call this.
    /// @param tweet A signed response to a watched account's request, with the tweet ID
    /// @param p0 A signed price of the asset, taken at most 10 minutes after the post
    function openTrigger(address user, bytes32 assetId, SignedResponse calldata tweet, SignedResponse calldata p0)
        external
        returns (uint256 triggerId);

    /// @notice Gate 2: buys if `p1` confirms the trend of an open trigger. Anyone can call this.
    /// @dev A P1 that fails a check reverts, and the trigger stays open until its window closes.
    function confirmTrigger(uint256 triggerId, SignedResponse calldata p1) external returns (uint256 positionId);

    /// @notice Closes a trigger whose window has closed without a buy. Anyone can call this.
    function expireTrigger(uint256 triggerId) external;

    /// @notice Sells a position at a signed price. Only the owner can sell by hand; anyone can sell for take-profit or a
    /// stagnation exit.
    function sell(uint256 positionId, SellReason reason, SignedResponse calldata price)
        external
        returns (uint256 quoteOut);

    function dex() external view returns (address);

    function quoteToken() external view returns (address);

    function balanceOf(address user) external view returns (uint256);

    function isPaused(address user) external view returns (bool);

    function getAssetProfile(bytes32 assetId) external view returns (AssetProfile memory);

    /// @notice The airnode that signs the responses of a watchable account, or the zero address
    function getWatchableAccount(bytes32 account) external view returns (address airnode);

    function getRule(address user)
        external
        view
        returns (Rule memory rule, bytes32[] memory assetIds, bytes32[] memory watchedAccounts);

    function getAssetRule(address user, bytes32 assetId)
        external
        view
        returns (bool isAllowed, AssetRule memory assetRule);

    /// @notice Quote tokens that the user's rule has spent on the asset during the current UTC day
    function spentToday(address user, bytes32 assetId) external view returns (uint256);

    function getTrigger(uint256 triggerId) external view returns (Trigger memory);

    function getPosition(uint256 positionId) external view returns (Position memory);
}
