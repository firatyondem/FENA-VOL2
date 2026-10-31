// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IMockDEX} from "../interfaces/IMockDEX.sol";
import {IVault} from "../interfaces/IVault.sol";
import {AirnodeV2Attestation} from "../lib/AirnodeV2Attestation.sol";
import {ProjectedJson} from "../lib/ProjectedJson.sol";

/// @title Tweet-triggered trading vault
/// @notice The agent proposes, the contract decides: every check that moves money runs here, against signed AirnodeHub
/// data and the user's stored rule. A wrong, buggy or malicious agent can only submit triggers that revert.
contract Vault is IVault, Ownable, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    /// @notice The DEX delivered less than the output it returned for a swap
    /// @dev Declared here and not in IVault, which stays frozen.
    error DexDeliveredLess(uint256 promised, uint256 delivered);

    /// @notice Longest time from an Airnode signing a response to the vault accepting it
    uint256 public constant MAX_RESPONSE_AGE = 5 minutes;

    /// @notice Longest time from a post to the source taking P0, so an old post cannot pair with a new price
    uint256 public constant MAX_POST_TO_P0 = 10 minutes;

    /// @dev Twitter's snowflake IDs hold the milliseconds since this epoch in their bits above bit 22.
    uint256 private constant TWITTER_EPOCH_MS = 1288834974657;
    uint256 private constant BPS = 10_000;

    address public immutable dex;
    address public immutable quoteToken;

    mapping(address user => uint256) public balanceOf;
    mapping(address user => bool) public isPaused;

    uint256 public triggerCount;
    uint256 public positionCount;

    mapping(bytes32 assetId => AssetProfile) private _assetProfiles;
    mapping(bytes32 account => address airnode) private _watchableAccounts;

    mapping(address user => Rule) private _rules;
    mapping(address user => bytes32[]) private _assetIds;
    mapping(address user => bytes32[]) private _watchedAccounts;
    mapping(address user => mapping(bytes32 assetId => AssetRule)) private _assetRules;
    mapping(address user => mapping(bytes32 assetId => bool)) private _isAssetAllowed;
    mapping(address user => mapping(bytes32 account => bool)) private _isWatched;

    mapping(address user => mapping(bytes32 assetId => mapping(uint256 tweetId => bool))) private _isTweetUsed;
    mapping(address user => mapping(bytes32 responseHash => bool)) private _isResponseUsed;
    mapping(address user => mapping(bytes32 assetId => mapping(uint256 day => uint256))) private _spent;
    mapping(address user => mapping(bytes32 assetId => uint256)) private _lastBuyAt;

    mapping(uint256 triggerId => Trigger) private _triggers;
    mapping(uint256 positionId => Position) private _positions;
    // The token that a position bought, so a later change to the asset's profile cannot make it sell another token
    mapping(uint256 positionId => address token) private _positionTokens;

    constructor(address admin, address dex_) Ownable(admin) {
        dex = dex_;
        quoteToken = IMockDEX(dex_).quoteToken();
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------------------------------------------------

    /// @inheritdoc IVault
    /// @dev A profile with the zero token removes the asset, so no trigger can open or confirm for it. A profile needs a
    /// wait and a threshold above zero, so a P1 always has to come later and higher than P0 and the agent can never buy
    /// on its own say.
    function setAssetProfile(bytes32 assetId, AssetProfile calldata profile) external onlyOwner {
        if (
            profile.token != address(0)
                && (profile.airnode == address(0)
                    || profile.minThresholdBps == 0
                    || profile.minThresholdBps > profile.maxSpikeCapBps
                    || profile.minWait == 0
                    || profile.minWait > profile.maxWindow
                    || profile.maxPriceAge == 0)
        ) revert InvalidRule();
        _assetProfiles[assetId] = profile;
        emit AssetProfileSet(assetId, profile);
    }

    /// @inheritdoc IVault
    function setWatchableAccount(bytes32 account, address airnode) external onlyOwner {
        _watchableAccounts[account] = airnode;
        emit WatchableAccountSet(account, airnode);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Vault
    // ---------------------------------------------------------------------------------------------------------------

    /// @inheritdoc IVault
    function deposit(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        balanceOf[msg.sender] += amount;
        IERC20(quoteToken).safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(msg.sender, amount);
    }

    /// @inheritdoc IVault
    function withdraw(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        uint256 balance = balanceOf[msg.sender];
        if (balance < amount) revert InsufficientBalance(balance, amount);
        balanceOf[msg.sender] = balance - amount;
        IERC20(quoteToken).safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    /// @inheritdoc IVault
    function setRule(
        Rule calldata rule,
        bytes32[] calldata assetIds,
        AssetRule[] calldata assetRules,
        string[] calldata assetTopics,
        bytes32[] calldata watchedAccounts
    ) external {
        if (
            rule.agent == address(0) || rule.buyAmount == 0 || rule.buyAmount > rule.maxPerTrade
                || assetIds.length != assetRules.length || assetIds.length != assetTopics.length
        ) revert InvalidRule();

        _clearRule(msg.sender);

        uint256 shareSum;
        for (uint256 i; i < assetIds.length; i++) {
            bytes32 assetId = assetIds[i];
            AssetRule calldata assetRule = assetRules[i];
            if (_isAssetAllowed[msg.sender][assetId]) revert InvalidRule();
            if (assetRule.thresholdBps > assetRule.spikeCapBps || assetRule.minWait > assetRule.maxWindow) {
                revert InvalidRule();
            }
            _checkAgainstProfile(assetId, assetRule);
            shareSum += assetRule.budgetShareBps;
            _isAssetAllowed[msg.sender][assetId] = true;
            _assetRules[msg.sender][assetId] = assetRule;
        }
        if (shareSum > BPS) revert InvalidRule();

        for (uint256 i; i < watchedAccounts.length; i++) {
            bytes32 account = watchedAccounts[i];
            if (_watchableAccounts[account] == address(0)) revert AccountNotRegistered(account);
            if (_isWatched[msg.sender][account]) revert InvalidRule();
            _isWatched[msg.sender][account] = true;
        }

        _rules[msg.sender] = rule;
        _assetIds[msg.sender] = assetIds;
        _watchedAccounts[msg.sender] = watchedAccounts;
        emit RuleSet(msg.sender, rule, assetIds, assetRules, assetTopics, watchedAccounts);
    }

    /// @inheritdoc IVault
    function setPaused(bool isPaused_) external {
        isPaused[msg.sender] = isPaused_;
        emit PausedSet(msg.sender, isPaused_);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Gate 1
    // ---------------------------------------------------------------------------------------------------------------

    /// @inheritdoc IVault
    function openTrigger(address user, bytes32 assetId, SignedResponse calldata tweet, SignedResponse calldata p0)
        external
        returns (uint256 triggerId)
    {
        // The language model's answer is not signed yet, so only the wallet that the user approved may say that a post
        // is relevant. Every other check stands on signed data.
        if (msg.sender != _rules[user].agent) revert NotAgent(msg.sender);
        if (isPaused[user]) revert RuleIsPaused(user);
        if (!_isAssetAllowed[user][assetId]) revert AssetNotAllowed(user, assetId);

        // The post: a watched account's request, signed by its Airnode, read once per asset of the rule
        bytes32 account = tweet.requestHash;
        if (!_isWatched[user][account]) revert AccountNotWatched(user, account);
        address tweetAirnode = _watchableAccounts[account];
        if (tweetAirnode == address(0)) revert AccountNotRegistered(account);
        _verifyResponse(tweetAirnode, account, tweet);
        uint256 tweetId = ProjectedJson.readUint(tweet.data, "id", 0);
        if (_isTweetUsed[user][assetId][tweetId]) revert TweetAlreadyUsed(user, assetId, tweetId);
        _isTweetUsed[user][assetId][tweetId] = true;

        // P0, taken at most MAX_POST_TO_P0 after the post. The tweet ID is signed, and its time bits are the post's.
        (uint256 p0Price, uint256 t0) = _verifyPrice(user, assetId, p0);
        uint256 tweetTime = ((tweetId >> 22) + TWITTER_EPOCH_MS) / 1000;
        if (t0 < tweetTime || t0 > tweetTime + MAX_POST_TO_P0) revert PriceOutsideTweetWindow(tweetTime, t0);

        triggerId = ++triggerCount;
        _triggers[triggerId] = Trigger({
            user: user,
            assetId: assetId,
            account: account,
            tweetId: tweetId,
            p0: p0Price,
            t0: t0,
            status: TriggerStatus.Open
        });
        emit TriggerOpened(triggerId, user, assetId, tweetId, p0Price, t0);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Gate 2
    // ---------------------------------------------------------------------------------------------------------------

    /// @inheritdoc IVault
    function confirmTrigger(uint256 triggerId, SignedResponse calldata p1)
        external
        nonReentrant
        returns (uint256 positionId)
    {
        Trigger storage trigger = _triggers[triggerId];
        if (trigger.status != TriggerStatus.Open) revert TriggerNotOpen(triggerId);
        address user = trigger.user;
        bytes32 assetId = trigger.assetId;
        if (isPaused[user]) revert RuleIsPaused(user);
        if (!_isAssetAllowed[user][assetId]) revert AssetNotAllowed(user, assetId);
        AssetRule memory assetRule = _assetRules[user][assetId];
        // The admin may have tightened the profile since the user set the rule.
        _checkAgainstProfile(assetId, assetRule);

        (uint256 p1Price, uint256 t1) = _verifyPrice(user, assetId, p1);
        _checkTrend(trigger.p0, trigger.t0, p1Price, t1, assetRule);
        uint256 amount = _spend(user, assetId, assetRule);

        trigger.status = TriggerStatus.Confirmed;
        address token = _assetProfiles[assetId].token;
        uint256 assetOut = _buy(token, amount, p1Price);
        positionId = ++positionCount;
        _positionTokens[positionId] = token;
        _positions[positionId] = Position({
            user: user,
            assetId: assetId,
            amount: assetOut,
            cost: amount,
            entryPrice: p1Price,
            openedAt: block.timestamp,
            isOpen: true
        });
        emit TriggerConfirmed(triggerId, positionId, p1Price, t1, amount, assetOut);
    }

    /// @inheritdoc IVault
    function expireTrigger(uint256 triggerId) external {
        Trigger storage trigger = _triggers[triggerId];
        if (trigger.status != TriggerStatus.Open) revert TriggerNotOpen(triggerId);
        // An asset that the user took out of the rule has no window left, so its trigger expires right away.
        uint256 deadline = trigger.t0 + _assetRules[trigger.user][trigger.assetId].maxWindow;
        if (block.timestamp <= deadline) revert WindowNotClosed(deadline);
        trigger.status = TriggerStatus.Expired;
        emit TriggerExpired(triggerId);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Selling
    // ---------------------------------------------------------------------------------------------------------------

    /// @inheritdoc IVault
    function sell(uint256 positionId, SellReason reason, SignedResponse calldata priceResponse)
        external
        nonReentrant
        returns (uint256 quoteOut)
    {
        Position storage position = _positions[positionId];
        if (!position.isOpen) revert PositionNotOpen(positionId);
        address user = position.user;
        bytes32 assetId = position.assetId;
        if (reason == SellReason.Manual) {
            if (msg.sender != user) revert NotPositionOwner(msg.sender);
        } else if (isPaused[user]) {
            revert RuleIsPaused(user);
        }

        // The same price can sell several positions, so it is not marked as used. Each position sells once.
        (uint256 price, uint256 priceTime) = _readPrice(assetId, priceResponse);
        if (priceTime < position.openedAt) revert PriceBeforeBuy(priceTime, position.openedAt);
        if (reason == SellReason.TakeProfit) {
            _checkTakeProfit(price, position.entryPrice, _assetRules[user][assetId]);
        } else if (reason == SellReason.Stagnation) {
            _checkStagnation(price, priceTime, position, _assetRules[user][assetId]);
        }

        position.isOpen = false;
        quoteOut = _sell(_positionTokens[positionId], position.amount, price);
        balanceOf[user] += quoteOut;
        emit PositionSold(positionId, user, reason, price, quoteOut);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------------------------

    function getAssetProfile(bytes32 assetId) external view returns (AssetProfile memory) {
        return _assetProfiles[assetId];
    }

    function getWatchableAccount(bytes32 account) external view returns (address airnode) {
        return _watchableAccounts[account];
    }

    function getRule(address user)
        external
        view
        returns (Rule memory rule, bytes32[] memory assetIds, bytes32[] memory watchedAccounts)
    {
        return (_rules[user], _assetIds[user], _watchedAccounts[user]);
    }

    function getAssetRule(address user, bytes32 assetId)
        external
        view
        returns (bool isAllowed, AssetRule memory assetRule)
    {
        return (_isAssetAllowed[user][assetId], _assetRules[user][assetId]);
    }

    function spentToday(address user, bytes32 assetId) external view returns (uint256) {
        return _spent[user][assetId][block.timestamp / 1 days];
    }

    function getTrigger(uint256 triggerId) external view returns (Trigger memory) {
        return _triggers[triggerId];
    }

    function getPosition(uint256 positionId) external view returns (Position memory) {
        return _positions[positionId];
    }

    /// @notice The checks every price must pass before a buy or a sell, open to anyone at any time: reverts with the
    /// vault's reason, or returns the price and when the source took it. Nothing moves and the response stays unused.
    /// @dev Declared here and not in IVault, which stays frozen. It runs the same _readPrice as confirmTrigger and sell.
    /// A buy's replay guard is per user, so it is not part of this check.
    function checkPrice(bytes32 assetId, SignedResponse calldata response)
        external
        view
        returns (uint256 price, uint256 priceTime)
    {
        return _readPrice(assetId, response);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Checks
    // ---------------------------------------------------------------------------------------------------------------

    /// @dev The signer, the request and the freshness of a response. The stored request hash goes into the digest, so
    /// the comparison before it only gives a clearer error for a response to another request.
    function _verifyResponse(address airnode, bytes32 requestHash, SignedResponse calldata response) private view {
        if (response.requestHash != requestHash) revert WrongRequestHash(requestHash, response.requestHash);
        AirnodeV2Attestation.verify(airnode, requestHash, response.timestamp, response.data, response.signature);
        if (response.timestamp + MAX_RESPONSE_AGE < block.timestamp) revert ResponseTooOld(response.timestamp);
    }

    /// @dev Verifies a price response and reads the price and the time at which the source took it. A price that is
    /// older than the profile allows means the market is closed or the feed is stale.
    function _readPrice(bytes32 assetId, SignedResponse calldata response)
        private
        view
        returns (uint256 price, uint256 priceTime)
    {
        AssetProfile storage profile = _assetProfiles[assetId];
        if (profile.token == address(0)) revert AssetNotRegistered(assetId);
        _verifyResponse(profile.airnode, profile.priceRequestHash, response);
        price = ProjectedJson.readUint(response.data, "price", 18);
        priceTime = ProjectedJson.readUint(response.data, "updatedAt", 0);
        if (profile.updatedAtInMs) priceTime /= 1000;
        if (priceTime + profile.maxPriceAge < block.timestamp) revert PriceTooOld(priceTime);
    }

    /// @dev Like _readPrice, but a buy uses each price response once per user.
    function _verifyPrice(address user, bytes32 assetId, SignedResponse calldata response)
        private
        returns (uint256 price, uint256 priceTime)
    {
        (price, priceTime) = _readPrice(assetId, response);
        bytes32 responseHash = keccak256(abi.encode(response.requestHash, response.timestamp, response.data));
        if (_isResponseUsed[user][responseHash]) revert ResponseAlreadyUsed(responseHash);
        _isResponseUsed[user][responseHash] = true;
    }

    function _checkAgainstProfile(bytes32 assetId, AssetRule memory assetRule) private view {
        AssetProfile storage profile = _assetProfiles[assetId];
        if (profile.token == address(0)) revert AssetNotRegistered(assetId);
        if (
            assetRule.thresholdBps < profile.minThresholdBps || assetRule.spikeCapBps > profile.maxSpikeCapBps
                || assetRule.minWait < profile.minWait || assetRule.maxWindow > profile.maxWindow
        ) revert RuleLooserThanProfile(assetId);
    }

    /// @dev minWait <= t1 - t0 <= maxWindow and P0 * (1 + threshold) <= P1 <= P0 * (1 + spike cap)
    function _checkTrend(uint256 p0, uint256 t0, uint256 p1, uint256 t1, AssetRule memory assetRule) private pure {
        if (t1 < t0 + assetRule.minWait) revert WaitNotOver(t0 + assetRule.minWait);
        if (t1 > t0 + assetRule.maxWindow) revert WindowClosed(t0 + assetRule.maxWindow);
        if (p1 * BPS < p0 * (BPS + assetRule.thresholdBps)) revert TrendTooWeak(p0, p1);
        if (p1 * BPS > p0 * (BPS + assetRule.spikeCapBps)) revert SpikeTooHigh(p0, p1);
    }

    /// @dev Checks the spending limits of a buy and books it against the user's balance and the asset's budget.
    function _spend(address user, bytes32 assetId, AssetRule memory assetRule) private returns (uint256 amount) {
        Rule storage rule = _rules[user];
        amount = rule.buyAmount;
        if (amount > rule.maxPerTrade) revert PerTradeLimitExceeded(amount, rule.maxPerTrade);

        uint256 lastBuyAt = _lastBuyAt[user][assetId];
        if (lastBuyAt != 0 && block.timestamp < lastBuyAt + assetRule.cooldown) {
            revert CooldownActive(lastBuyAt + assetRule.cooldown);
        }

        uint256 day = block.timestamp / 1 days;
        // mulDiv, so any daily limit works, up to type(uint256).max for "no limit"
        uint256 budget = Math.mulDiv(rule.dailyLimit, assetRule.budgetShareBps, BPS);
        uint256 spent = _spent[user][assetId][day];
        if (spent + amount > budget) revert DailyBudgetExceeded(amount, budget > spent ? budget - spent : 0);

        uint256 balance = balanceOf[user];
        if (balance < amount) revert InsufficientBalance(balance, amount);

        balanceOf[user] = balance - amount;
        _spent[user][assetId][day] = spent + amount;
        _lastBuyAt[user][assetId] = block.timestamp;
    }

    /// @dev Take-profit off (0) never sells. The target rounds up, so a price below entry * (1 + take-profit) by less than
    /// a wei does not sell, as exact as the trend and stagnation checks.
    function _checkTakeProfit(uint256 price, uint256 entryPrice, AssetRule memory assetRule) private pure {
        uint256 target = assetRule.takeProfitBps == 0
            ? type(uint256).max
            : Math.ceilDiv(entryPrice * (BPS + assetRule.takeProfitBps), BPS);
        if (price < target) revert TakeProfitNotReached(price, target);
    }

    /// @dev At least the stagnation delay after the buy, the price is still within entry * (1 +- band). A stagnation
    /// exit that is off (delay 0) never sells.
    function _checkStagnation(uint256 price, uint256 priceTime, Position storage position, AssetRule memory assetRule)
        private
        view
    {
        uint256 earliest =
            assetRule.stagnationDelay == 0 ? type(uint256).max : position.openedAt + assetRule.stagnationDelay;
        if (priceTime < earliest) revert StagnationDelayNotOver(earliest);
        uint256 entryPrice = position.entryPrice;
        uint256 distance = price > entryPrice ? price - entryPrice : entryPrice - price;
        if (distance * BPS > entryPrice * assetRule.stagnationBandBps) {
            revert PriceOutsideStagnationBand(price, entryPrice);
        }
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Swaps and rule storage
    // ---------------------------------------------------------------------------------------------------------------

    /// @dev Counts what the DEX actually sent, and reverts if that is less than the output it returned.
    function _buy(address asset, uint256 quoteIn, uint256 price) private returns (uint256 assetOut) {
        uint256 balanceBefore = IERC20(asset).balanceOf(address(this));
        IERC20(quoteToken).forceApprove(dex, quoteIn);
        uint256 promised = IMockDEX(dex).buy(asset, quoteIn, price);
        assetOut = IERC20(asset).balanceOf(address(this)) - balanceBefore;
        if (assetOut < promised) revert DexDeliveredLess(promised, assetOut);
    }

    function _sell(address asset, uint256 assetIn, uint256 price) private returns (uint256 quoteOut) {
        uint256 balanceBefore = IERC20(quoteToken).balanceOf(address(this));
        IERC20(asset).forceApprove(dex, assetIn);
        uint256 promised = IMockDEX(dex).sell(asset, assetIn, price);
        quoteOut = IERC20(quoteToken).balanceOf(address(this)) - balanceBefore;
        if (quoteOut < promised) revert DexDeliveredLess(promised, quoteOut);
    }

    function _clearRule(address user) private {
        bytes32[] storage assetIds = _assetIds[user];
        for (uint256 i; i < assetIds.length; i++) {
            delete _isAssetAllowed[user][assetIds[i]];
            delete _assetRules[user][assetIds[i]];
        }
        bytes32[] storage watchedAccounts = _watchedAccounts[user];
        for (uint256 i; i < watchedAccounts.length; i++) {
            delete _isWatched[user][watchedAccounts[i]];
        }
    }
}
