// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title A vault that buys after a relevant post, but only when Pyth prices confirm the move
/// @notice One contract holds every user's funds, with a balance and one rule per user. The user's agent wallet opens a
/// trigger for a post with a Pyth price P0 (Gate 1). Anyone can confirm it with a later Pyth price P1, and the vault buys
/// only if P1 passes the trend, spike, timing, market-hours and spending checks of the rule (Gate 2). Positions sell at a
/// Pyth price: by hand, or by anyone for take-profit, stop-loss or a stagnation exit.
/// @dev Units: percentages in basis points (10_000 = 100%), durations and times in seconds, prices with 18 decimals,
/// amounts in token units.
///
/// Every price is a Pyth price update (`bytes[]`, as Hermes serves it) that the vault hands to the Pyth contract, which
/// verifies its signatures. The vault pays Pyth's update fee from `msg.value` and sends any excess back to the caller, so
/// every function that takes a price update is payable; `updateFee` says what to send.
///
/// P0 must be the first Pyth price published at or after the post, and at most MAX_POST_TO_P0 after it, so the agent
/// cannot pick a favourable price. Posts are not signed: the vault takes the post's time from its tweet ID, trusts the
/// agent wallet that the post exists, and refuses a post older than MAX_POST_AGE. A fake post can at most open a price
/// check; nothing is bought unless later Pyth prices confirm the move.
///
/// Each P0 and P1 is recorded per user and asset under its publish time: it cannot open or confirm a second trigger of
/// the same user and asset (PriceAlreadyUsed). Sell prices are not recorded, so one price can sell several positions;
/// each position sells once.
interface IVault {
    /// @notice Limits that the admin sets for an asset. A user's rule can be stricter, never looser.
    struct AssetProfile {
        // Mock token that the vault buys, such as tETH
        address token;
        // Pyth price feed ID, such as ETH/USD
        bytes32 priceId;
        // Lowest trend threshold that a rule may set
        uint16 minThresholdBps;
        // Highest spike cap that a rule may set
        uint16 maxSpikeCapBps;
        // Shortest wait between P0 and P1 that a rule may set
        uint32 minWait;
        // Longest window between P0 and P1 that a rule may set
        uint32 maxWindow;
        // Longest time from Pyth publishing a P1 or sell price to the vault using it. A closed market publishes no new
        // prices, so this check keeps the vault from trading while the market is closed.
        uint32 maxPriceAge;
        // Widest confidence interval accepted, as a share of the price
        uint16 maxConfBps;
        // Highest stop-loss that a rule may set; a stop-loss of 0 (off) is always allowed. Below 10_000.
        uint16 maxStopLossBps;
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
        // Anyone can sell a position when P <= entry * (1 - stop-loss). 0 turns stop-loss off.
        uint16 stopLossBps;
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
        // Account ID of the post: keccak256 of the lower-case handle
        bytes32 account;
        uint256 tweetId;
        uint256 p0;
        // Time at which Pyth published P0
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

    /// @notice The sell rules of a position, copied from the user's asset rule when it was bought. A later change of the
    /// rule does not change them.
    struct PositionExits {
        uint16 takeProfitBps;
        uint16 stopLossBps;
        uint16 stagnationBandBps;
        uint32 stagnationDelay;
    }

    enum SellReason {
        Manual,
        TakeProfit,
        Stagnation,
        StopLoss
    }

    event AssetProfileSet(bytes32 indexed assetId, AssetProfile profile);
    event WatchableAccountSet(bytes32 indexed account, bool isWatchable);
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

    // Prices
    error InsufficientFee(uint256 sent, uint256 fee);
    error RefundFailed();
    // Pyth refused the update: an edited payload, a bad signature or bytes that are no update at all
    error InvalidPriceUpdate();
    // The update has no price for the asset's feed
    error WrongPriceFeed(bytes32 priceId);
    error PriceTooOld(uint256 publishTime);
    error PriceAlreadyUsed(bytes32 assetId, uint256 publishTime);
    error PriceNotPositive();
    error PriceTooUncertain(uint256 conf, uint256 price);

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
    error PostOutsideWindow(uint256 tweetTime);
    error PriceOutsideTweetWindow(uint256 tweetTime, uint256 priceTime);
    error PriceNotFirstAfterPost(uint256 tweetTime, uint256 priceTime);

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
    error StopLossNotReached(uint256 price, uint256 line);
    error StagnationDelayNotOver(uint256 earliest);
    error PriceOutsideStagnationBand(uint256 price, uint256 entryPrice);

    /// @notice Sets the limits of an asset. Only the admin can call this.
    function setAssetProfile(bytes32 assetId, AssetProfile calldata profile) external;

    /// @notice Lets rules watch an account, or stops new rules from watching it. Only the admin can call this.
    /// @param account keccak256 of the account's lower-case handle, such as keccak256("elonmusk")
    function setWatchableAccount(bytes32 account, bool isWatchable) external;

    /// @notice Moves `amount` quote tokens from the caller into the caller's balance in the vault
    function deposit(uint256 amount) external;

    /// @notice Moves `amount` quote tokens from the caller's balance in the vault to the caller, even while paused
    function withdraw(uint256 amount) external;

    /// @notice Replaces the caller's rule. Open triggers keep their P0 and wait under the new rule; open positions keep
    /// the exits they were bought with.
    /// @param assetIds Assets that the rule may buy, in the user's priority order
    /// @param assetRules The rule for each asset in `assetIds`
    /// @param assetTopics For each asset in `assetIds`, the comma-separated topic keywords that the agent checks posts
    /// against at Gate 1. RuleSet emits them, and the vault does not store them, so the agent reads the latest RuleSet.
    /// @param watchedAccounts Account IDs whose posts can open triggers
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
    /// @param account The post's account ID
    /// @param tweetId The post's ID; its snowflake time bits give the post's time
    /// @param p0Update A Pyth update whose price is the first one published at or after the post
    function openTrigger(address user, bytes32 assetId, bytes32 account, uint256 tweetId, bytes[] calldata p0Update)
        external
        payable
        returns (uint256 triggerId);

    /// @notice Gate 2: buys if `p1Update` confirms the trend of an open trigger. Anyone can call this.
    /// @dev A P1 that fails a check reverts, and the trigger stays open until its window closes.
    function confirmTrigger(uint256 triggerId, bytes[] calldata p1Update) external payable returns (uint256 positionId);

    /// @notice Closes a trigger whose window has closed without a buy. Anyone can call this.
    function expireTrigger(uint256 triggerId) external;

    /// @notice Sells a position at a Pyth price. Only the owner can sell by hand; anyone can sell for take-profit,
    /// stop-loss or a stagnation exit.
    function sell(uint256 positionId, SellReason reason, bytes[] calldata priceUpdate)
        external
        payable
        returns (uint256 quoteOut);

    /// @notice The checks every P1 and sell price must pass, open to anyone: reverts with the vault's reason, or returns
    /// the price and its publish time. Nothing is recorded; send it as an eth_call with `updateFee` as the value.
    function checkPrice(bytes32 assetId, bytes[] calldata priceUpdate)
        external
        payable
        returns (uint256 price, uint256 publishTime);

    /// @notice The wei to send with a price update
    function updateFee(bytes[] calldata priceUpdate) external view returns (uint256);

    function pyth() external view returns (address);

    function dex() external view returns (address);

    function quoteToken() external view returns (address);

    function balanceOf(address user) external view returns (uint256);

    function isPaused(address user) external view returns (bool);

    function getAssetProfile(bytes32 assetId) external view returns (AssetProfile memory);

    function isWatchableAccount(bytes32 account) external view returns (bool);

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

    function getPositionExits(uint256 positionId) external view returns (PositionExits memory);
}
