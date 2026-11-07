// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPyth} from "@pythnetwork/pyth-sdk-solidity/IPyth.sol";
import {PythErrors} from "@pythnetwork/pyth-sdk-solidity/PythErrors.sol";
import {PythStructs} from "@pythnetwork/pyth-sdk-solidity/PythStructs.sol";
import {IMockDEX} from "../interfaces/IMockDEX.sol";
import {IVault} from "../interfaces/IVault.sol";

/// @title Post-triggered trading vault on Pyth prices
/// @notice The agent proposes, the contract decides: every check that moves money runs here, against prices that the
/// Pyth contract verifies and the user's stored rule. A wrong, buggy or malicious agent can only submit triggers that
/// revert, or open price checks that never buy unless the market really moves.
contract Vault is IVault, Ownable, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    /// @notice The DEX delivered less than the output it returned for a swap
    error DexDeliveredLess(uint256 promised, uint256 delivered);

    /// @notice Longest time from a post to Pyth publishing P0
    uint256 public constant MAX_POST_TO_P0 = 10 minutes;

    /// @notice Longest time from a post to the agent opening its trigger. Posts are not signed, so this bounds how far
    /// back an agent could place a made-up post.
    uint256 public constant MAX_POST_AGE = 30 minutes;

    /// @dev Twitter's snowflake IDs hold the milliseconds since this epoch in their bits above bit 22.
    uint256 private constant TWITTER_EPOCH_MS = 1288834974657;
    uint256 private constant BPS = 10_000;
    uint256 private constant PRICE_DECIMALS = 18;

    IPyth private immutable _pyth;
    address public immutable dex;
    address public immutable quoteToken;

    mapping(address user => uint256) public balanceOf;
    mapping(address user => bool) public isPaused;

    uint256 public triggerCount;
    uint256 public positionCount;

    mapping(bytes32 assetId => AssetProfile) private _assetProfiles;
    mapping(bytes32 account => bool) private _isWatchableAccount;

    mapping(address user => Rule) private _rules;
    mapping(address user => bytes32[]) private _assetIds;
    mapping(address user => bytes32[]) private _watchedAccounts;
    mapping(address user => mapping(bytes32 assetId => AssetRule)) private _assetRules;
    mapping(address user => mapping(bytes32 assetId => bool)) private _isAssetAllowed;
    mapping(address user => mapping(bytes32 account => bool)) private _isWatched;

    mapping(address user => mapping(bytes32 assetId => mapping(uint256 tweetId => bool))) private _isTweetUsed;
    mapping(address user => mapping(bytes32 assetId => mapping(uint256 publishTime => bool))) private _isPriceUsed;
    mapping(address user => mapping(bytes32 assetId => mapping(uint256 day => uint256))) private _spent;
    mapping(address user => mapping(bytes32 assetId => uint256)) private _lastBuyAt;

    mapping(uint256 triggerId => Trigger) private _triggers;
    mapping(uint256 positionId => Position) private _positions;
    mapping(uint256 positionId => PositionExits) private _positionExits;
    // The token that a position bought, so a later change to the asset's profile cannot make it sell another token
    mapping(uint256 positionId => address token) private _positionTokens;

    constructor(address admin, address dex_, address pyth_) Ownable(admin) {
        dex = dex_;
        quoteToken = IMockDEX(dex_).quoteToken();
        _pyth = IPyth(pyth_);
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
                && (profile.priceId == bytes32(0)
                    || profile.minThresholdBps == 0
                    || profile.minThresholdBps > profile.maxSpikeCapBps
                    || profile.minWait == 0
                    || profile.minWait > profile.maxWindow
                    || profile.maxPriceAge == 0
                    || profile.maxConfBps == 0
                    || profile.maxStopLossBps >= BPS)
        ) revert InvalidRule();
        _assetProfiles[assetId] = profile;
        emit AssetProfileSet(assetId, profile);
    }

    /// @inheritdoc IVault
    function setWatchableAccount(bytes32 account, bool isWatchable) external onlyOwner {
        _isWatchableAccount[account] = isWatchable;
        emit WatchableAccountSet(account, isWatchable);
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
            if (!_isWatchableAccount[account]) revert AccountNotRegistered(account);
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
    function openTrigger(address user, bytes32 assetId, bytes32 account, uint256 tweetId, bytes[] calldata p0Update)
        external
        payable
        nonReentrant
        returns (uint256 triggerId)
    {
        // The language model's answer and the post are not signed, so only the wallet that the user approved may say
        // that a relevant post exists. Every check that moves money stands on Pyth prices.
        if (msg.sender != _rules[user].agent) revert NotAgent(msg.sender);
        if (isPaused[user]) revert RuleIsPaused(user);
        if (!_isAssetAllowed[user][assetId]) revert AssetNotAllowed(user, assetId);
        if (!_isWatched[user][account]) revert AccountNotWatched(user, account);
        if (!_isWatchableAccount[account]) revert AccountNotRegistered(account);

        uint256 tweetTime = ((tweetId >> 22) + TWITTER_EPOCH_MS) / 1000;
        if (tweetTime > block.timestamp || block.timestamp > tweetTime + MAX_POST_AGE) {
            revert PostOutsideWindow(tweetTime);
        }
        if (_isTweetUsed[user][assetId][tweetId]) revert TweetAlreadyUsed(user, assetId, tweetId);
        _isTweetUsed[user][assetId][tweetId] = true;

        // P0: the first price at or after the post, at most MAX_POST_TO_P0 after it
        uint256 fee = _takeFee(p0Update);
        (uint256 p0, uint256 t0) = _readPrice(assetId, p0Update, fee, tweetTime);
        _useOnce(user, assetId, t0);

        triggerId = ++triggerCount;
        _triggers[triggerId] = Trigger({
            user: user, assetId: assetId, account: account, tweetId: tweetId, p0: p0, t0: t0, status: TriggerStatus.Open
        });
        emit TriggerOpened(triggerId, user, assetId, tweetId, p0, t0);
        _refund(fee);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Gate 2
    // ---------------------------------------------------------------------------------------------------------------

    /// @inheritdoc IVault
    function confirmTrigger(uint256 triggerId, bytes[] calldata p1Update)
        external
        payable
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

        uint256 fee = _takeFee(p1Update);
        (uint256 p1, uint256 t1) = _readFreshPrice(assetId, p1Update, fee);
        _checkTrend(trigger.p0, trigger.t0, p1, t1, assetRule);
        _useOnce(user, assetId, t1);
        uint256 amount = _spend(user, assetId, assetRule);

        trigger.status = TriggerStatus.Confirmed;
        address token = _assetProfiles[assetId].token;
        uint256 assetOut = _buy(token, amount, p1);
        positionId = ++positionCount;
        _positionTokens[positionId] = token;
        _positions[positionId] = Position({
            user: user,
            assetId: assetId,
            amount: assetOut,
            cost: amount,
            entryPrice: p1,
            openedAt: block.timestamp,
            isOpen: true
        });
        _positionExits[positionId] = PositionExits({
            takeProfitBps: assetRule.takeProfitBps,
            stopLossBps: assetRule.stopLossBps,
            stagnationBandBps: assetRule.stagnationBandBps,
            stagnationDelay: assetRule.stagnationDelay
        });
        emit TriggerConfirmed(triggerId, positionId, p1, t1, amount, assetOut);
        _refund(fee);
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
    function sell(uint256 positionId, SellReason reason, bytes[] calldata priceUpdate)
        external
        payable
        nonReentrant
        returns (uint256 quoteOut)
    {
        Position storage position = _positions[positionId];
        if (!position.isOpen) revert PositionNotOpen(positionId);
        address user = position.user;
        if (reason == SellReason.Manual) {
            if (msg.sender != user) revert NotPositionOwner(msg.sender);
        } else if (isPaused[user]) {
            revert RuleIsPaused(user);
        }

        // The same price can sell several positions, so it is not marked as used. Each position sells once.
        uint256 fee = _takeFee(priceUpdate);
        (uint256 price, uint256 priceTime) = _readFreshPrice(position.assetId, priceUpdate, fee);
        if (priceTime < position.openedAt) revert PriceBeforeBuy(priceTime, position.openedAt);
        PositionExits memory exits = _positionExits[positionId];
        if (reason == SellReason.TakeProfit) {
            _checkTakeProfit(price, position.entryPrice, exits.takeProfitBps);
        } else if (reason == SellReason.StopLoss) {
            _checkStopLoss(price, position.entryPrice, exits.stopLossBps);
        } else if (reason == SellReason.Stagnation) {
            _checkStagnation(price, priceTime, position, exits);
        }

        position.isOpen = false;
        quoteOut = _sell(_positionTokens[positionId], position.amount, price);
        balanceOf[user] += quoteOut;
        emit PositionSold(positionId, user, reason, price, quoteOut);
        _refund(fee);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------------------------

    /// @inheritdoc IVault
    function checkPrice(bytes32 assetId, bytes[] calldata priceUpdate)
        external
        payable
        nonReentrant
        returns (uint256 price, uint256 publishTime)
    {
        uint256 fee = _takeFee(priceUpdate);
        (price, publishTime) = _readFreshPrice(assetId, priceUpdate, fee);
        _refund(fee);
    }

    /// @inheritdoc IVault
    function updateFee(bytes[] calldata priceUpdate) external view returns (uint256) {
        return _pyth.getUpdateFee(priceUpdate);
    }

    function pyth() external view returns (address) {
        return address(_pyth);
    }

    function getAssetProfile(bytes32 assetId) external view returns (AssetProfile memory) {
        return _assetProfiles[assetId];
    }

    function isWatchableAccount(bytes32 account) external view returns (bool) {
        return _isWatchableAccount[account];
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

    function getPositionExits(uint256 positionId) external view returns (PositionExits memory) {
        return _positionExits[positionId];
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Prices
    // ---------------------------------------------------------------------------------------------------------------

    function _takeFee(bytes[] calldata priceUpdate) private view returns (uint256 fee) {
        fee = _pyth.getUpdateFee(priceUpdate);
        if (msg.value < fee) revert InsufficientFee(msg.value, fee);
    }

    /// @dev Sends back what the caller paid above Pyth's fee. Every caller is behind nonReentrant.
    function _refund(uint256 fee) private {
        uint256 excess = msg.value - fee;
        if (excess == 0) return;
        (bool ok,) = msg.sender.call{value: excess}("");
        if (!ok) revert RefundFailed();
    }

    /// @dev A P1 or sell price: any price of the asset's feed in the update, published at most maxPriceAge ago.
    function _readFreshPrice(bytes32 assetId, bytes[] calldata priceUpdate, uint256 fee)
        private
        returns (uint256 price, uint256 publishTime)
    {
        (price, publishTime) = _readPrice(assetId, priceUpdate, fee, 0);
        if (publishTime + _assetProfiles[assetId].maxPriceAge < block.timestamp) revert PriceTooOld(publishTime);
    }

    /// @dev Lets Pyth verify the update and returns the price with 18 decimals and its publish time. With `postTime` set,
    /// the price must be the first one at or after the post (Pyth's uniqueness check) and at most MAX_POST_TO_P0 after
    /// it. Pyth names only a few failures, so a refused update is parsed again without limits to tell the vault's
    /// reason; the fee of the call that reverted stays in the vault for that second call.
    function _readPrice(bytes32 assetId, bytes[] calldata priceUpdate, uint256 fee, uint256 postTime)
        private
        returns (uint256 price, uint256 publishTime)
    {
        AssetProfile storage profile = _assetProfiles[assetId];
        if (profile.token == address(0)) revert AssetNotRegistered(assetId);
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = profile.priceId;

        PythStructs.PriceFeed[] memory feeds;
        if (postTime == 0) {
            try _pyth.parsePriceFeedUpdates{value: fee}(priceUpdate, ids, 0, type(uint64).max) returns (
                PythStructs.PriceFeed[] memory parsed
            ) {
                feeds = parsed;
            } catch (bytes memory reason) {
                _revertForPyth(reason);
                // Without a time window, a missing price can only mean that the update has no price for the feed.
                revert WrongPriceFeed(profile.priceId);
            }
        } else {
            uint64 latest = uint64(postTime + MAX_POST_TO_P0);
            try _pyth.parsePriceFeedUpdatesUnique{value: fee}(priceUpdate, ids, uint64(postTime), latest) returns (
                PythStructs.PriceFeed[] memory parsed
            ) {
                feeds = parsed;
            } catch (bytes memory reason) {
                _revertForPyth(reason);
                _explainP0(priceUpdate, ids, fee, postTime);
            }
        }

        PythStructs.Price memory pythPrice = feeds[0].price;
        if (pythPrice.price <= 0) revert PriceNotPositive();
        // forge-lint: disable-next-line(unsafe-typecast)
        uint256 raw = uint256(int256(pythPrice.price));
        if (uint256(pythPrice.conf) * BPS > raw * profile.maxConfBps) {
            revert PriceTooUncertain(_scale(pythPrice.conf, pythPrice.expo), _scale(raw, pythPrice.expo));
        }
        price = _scale(raw, pythPrice.expo);
        publishTime = pythPrice.publishTime;
    }

    /// @dev Pyth refused the update. PriceFeedNotFoundWithinRange is left for the caller to explain; it is the only
    /// refusal that a well-formed, correctly signed update can get.
    function _revertForPyth(bytes memory reason) private pure {
        if (bytes4(reason) != PythErrors.PriceFeedNotFoundWithinRange.selector) revert InvalidPriceUpdate();
    }

    /// @dev The update is valid but Pyth found no unique price in the P0 window: tells which check failed.
    function _explainP0(bytes[] calldata priceUpdate, bytes32[] memory ids, uint256 fee, uint256 postTime) private {
        try _pyth.parsePriceFeedUpdates{value: fee}(priceUpdate, ids, 0, type(uint64).max) returns (
            PythStructs.PriceFeed[] memory parsed
        ) {
            uint256 priceTime = parsed[0].price.publishTime;
            if (priceTime < postTime || priceTime > postTime + MAX_POST_TO_P0) {
                revert PriceOutsideTweetWindow(postTime, priceTime);
            }
            revert PriceNotFirstAfterPost(postTime, priceTime);
        } catch (bytes memory) {
            revert WrongPriceFeed(ids[0]);
        }
    }

    /// @dev value * 10^(18 + expo). Pyth's exponents are small negatives, such as -8 or -5.
    function _scale(uint256 value, int32 expo) private pure returns (uint256) {
        int256 shift = int256(PRICE_DECIMALS) + expo;
        // forge-lint: disable-next-line(unsafe-typecast)
        return shift >= 0 ? value * 10 ** uint256(shift) : value / 10 ** uint256(-shift);
    }

    function _useOnce(address user, bytes32 assetId, uint256 publishTime) private {
        if (_isPriceUsed[user][assetId][publishTime]) revert PriceAlreadyUsed(assetId, publishTime);
        _isPriceUsed[user][assetId][publishTime] = true;
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Checks
    // ---------------------------------------------------------------------------------------------------------------

    function _checkAgainstProfile(bytes32 assetId, AssetRule memory assetRule) private view {
        AssetProfile storage profile = _assetProfiles[assetId];
        if (profile.token == address(0)) revert AssetNotRegistered(assetId);
        if (
            assetRule.thresholdBps < profile.minThresholdBps || assetRule.spikeCapBps > profile.maxSpikeCapBps
                || assetRule.minWait < profile.minWait || assetRule.maxWindow > profile.maxWindow
                || assetRule.stopLossBps > profile.maxStopLossBps
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
    /// a wei does not sell.
    function _checkTakeProfit(uint256 price, uint256 entryPrice, uint16 takeProfitBps) private pure {
        uint256 target = takeProfitBps == 0 ? type(uint256).max : Math.ceilDiv(entryPrice * (BPS + takeProfitBps), BPS);
        if (price < target) revert TakeProfitNotReached(price, target);
    }

    /// @dev Sells when P <= entry * (1 - stop-loss), compared without rounding. Stop-loss off (0) never sells, since every
    /// price is above zero.
    function _checkStopLoss(uint256 price, uint256 entryPrice, uint16 stopLossBps) private pure {
        uint256 scaledLine = stopLossBps == 0 ? 0 : entryPrice * (BPS - stopLossBps);
        if (price * BPS > scaledLine) revert StopLossNotReached(price, scaledLine / BPS);
    }

    /// @dev At least the stagnation delay after the buy, the price is still within entry * (1 +- band). A stagnation
    /// exit that is off (delay 0) never sells.
    function _checkStagnation(uint256 price, uint256 priceTime, Position storage position, PositionExits memory exits)
        private
        view
    {
        uint256 earliest = exits.stagnationDelay == 0 ? type(uint256).max : position.openedAt + exits.stagnationDelay;
        if (priceTime < earliest) revert StagnationDelayNotOver(earliest);
        uint256 entryPrice = position.entryPrice;
        uint256 distance = price > entryPrice ? price - entryPrice : entryPrice - price;
        if (distance * BPS > entryPrice * exits.stagnationBandBps) {
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
