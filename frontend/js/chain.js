// ===== Chain: the only file that knows ethers =====
// Live mode reads the deployed vault through a plain RPC (so the page shows data before a wallet connects) and writes
// through the user's own wallet. Every write is simulated first, so a revert names its reason before the wallet opens.

const MODE = (new URLSearchParams(location.search).get("mode") || DEFAULT_MODE) === "live" ? "live" : "practice";

class Cancelled extends Error {
  constructor() { super("You cancelled in your wallet"); this.reason = "UserRejected"; }
}
class LoadError extends Error {}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const TRIGGER_STATUS = ["none", "open", "confirmed", "expired"];
const SELL_REASON = ["Manual", "TakeProfit", "Stagnation"];
const TOKEN_ABI = ["function decimals() view returns (uint8)", "function symbol() view returns (string)"];
const LOG_CHUNK = 2000;

// A struct or tuple from ethers as a plain object or array of plain values
function plain(value) {
  if (value && typeof value.toObject === "function") {
    try {
      const obj = value.toObject();
      const keys = Object.keys(obj);
      // ethers names the one item of an unnamed list "_", so a rule with one asset would stop being a list
      if (keys.length && keys[0] !== "_") return Object.fromEntries(keys.map(key => [key, plain(obj[key])]));
    } catch { /* unnamed tuple: fall through to the array */ }
    return Array.from(value, plain);
  }
  return value;
}

const Chain = {
  mode: MODE,
  chainId: Number(new URLSearchParams(location.search).get("chain") || DEFAULT_CHAIN_ID),
  network: null,
  deployment: null,
  requestHashes: null,
  read: {},            // { provider, vault, usdc } over the network's RPC
  account: null,       // the connected wallet address
  signer: null,
  tokenDecimals: {},   // asset key -> decimals of its mock token
  profiles: {},        // asset key -> on-chain AssetProfile (limits for the rule editor)
  assetOfId: {},       // asset id (lowercase) -> key
  handleOfAccount: {}, // watched-account request hash (lowercase) -> X handle
  logs: [],            // every vault event since the deployment, parsed, oldest first
  scannedTo: null,
  blockTimes: new Map(),
  onTransaction: null, // ({ label, hash, url, stage }) for toasts

  explorerTx(hash) { return this.network?.explorer ? `${this.network.explorer}/tx/${hash}` : null; },

  // Fetches the deployment, ABIs and request hashes, and reads what never changes: decimals and asset profiles
  async load() {
    this.network = NETWORKS[this.chainId];
    if (!this.network) throw new LoadError(`No network ${this.chainId} in config.js.`);
    const fetchJson = async path => {
      const response = await fetch(path, { cache: "no-store" });
      if (!response.ok) throw new LoadError(`Missing ${path.replace("../", "")}. Deploy first, or switch to practice mode.`);
      return response.json();
    };
    const [deployment, vaultAbi, usdcAbi, requestHashes] = await Promise.all([
      fetchJson(`../shared/deployments/${this.chainId}.json`),
      fetchJson("../shared/deployments/abi/Vault.json"),
      fetchJson("../shared/deployments/abi/MockUSDC.json"),
      fetchJson("../shared/deployments/request-hashes.json"),
    ]);
    this.deployment = deployment;
    this.requestHashes = requestHashes;
    this.abis = { vault: vaultAbi, usdc: usdcAbi };
    const provider = new ethers.JsonRpcProvider(this.network.rpc, this.chainId, { staticNetwork: true });
    this.read = {
      provider,
      vault: new ethers.Contract(deployment.vault, vaultAbi, provider),
      usdc: new ethers.Contract(deployment.usdc, usdcAbi, provider),
    };
    this.assetOfId = Object.fromEntries(Object.entries(deployment.assetIds).map(([k, id]) => [id.toLowerCase(), k]));
    this.handleOfAccount = Object.fromEntries(Object.entries(requestHashes.posts).map(([h, p]) => [p.requestHash.toLowerCase(), h]));

    try {
      await provider.getBlockNumber();
    } catch {
      throw new LoadError(`Can't reach ${this.network.name} at ${this.network.rpc}.`);
    }
    const decimals = await this.read.usdc.decimals().catch(() => 6);
    Units.setUsdcDecimals(decimals);
    const keys = Object.keys(deployment.assets);
    await Promise.all(keys.map(async key => {
      const token = new ethers.Contract(deployment.assets[key], TOKEN_ABI, provider);
      this.tokenDecimals[key] = Number(await token.decimals().catch(() => 18));
      const profile = plain(await this.read.vault.getAssetProfile(deployment.assetIds[key]));
      this.profiles[key] = {
        token: profile.token, airnode: profile.airnode,
        minThresholdBps: Number(profile.minThresholdBps), maxSpikeCapBps: Number(profile.maxSpikeCapBps),
        minWait: Number(profile.minWait), maxWindow: Number(profile.maxWindow), maxPriceAge: Number(profile.maxPriceAge),
      };
    }));
  },

  async switchNetwork() {
    const chainId = "0x" + this.chainId.toString(16);
    try {
      await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
    } catch (error) {
      if (error.code !== 4902) throw this.decodeError(error);
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId, chainName: this.network.name, rpcUrls: [this.network.rpc],
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
          blockExplorerUrls: this.network.explorer ? [this.network.explorer] : undefined,
        }],
      });
    }
  },

  // The wallet as an ethers provider, checking for receipts as often as the page polls (ethers' default is 4 s)
  walletProvider() {
    const provider = new ethers.BrowserProvider(window.ethereum);
    provider.pollingInterval = this.network.pollMs;
    return provider;
  },

  // Asks the wallet for an account on this network. onAccount runs again whenever the user switches accounts.
  async connect(onAccount) {
    if (!window.ethereum) throw new Revert("NoWallet");
    try {
      await window.ethereum.request({ method: "eth_requestAccounts" });
      if (Number(await window.ethereum.request({ method: "eth_chainId" })) !== this.chainId) await this.switchNetwork();
    } catch (error) {
      throw this.decodeError(error);
    }
    this.signer = await this.walletProvider().getSigner();
    this.account = ethers.getAddress(await this.signer.getAddress());
    if (!this.listening && window.ethereum.on) {
      this.listening = true;
      window.ethereum.on("accountsChanged", async accounts => {
        if (!accounts.length) { this.account = this.signer = null; onAccount(null); return; }
        this.signer = await this.walletProvider().getSigner();
        this.account = ethers.getAddress(accounts[0]);
        onAccount(this.account);
      });
      window.ethereum.on("chainChanged", () => location.reload());
    }
    onAccount(this.account);
    return this.account;
  },

  // A wallet or contract error as Cancelled, a Revert named after the contract's custom error, or the error itself
  decodeError(error) {
    if (error instanceof Revert || error instanceof Cancelled) return error;
    const codes = [error?.code, error?.info?.error?.code, error?.error?.code];
    if (codes.includes("ACTION_REJECTED") || codes.includes(4001)) return new Cancelled();
    if (error?.revert?.name) return new Revert(error.revert.name);
    const data = error?.data ?? error?.info?.error?.data ?? error?.error?.data;
    for (const contract of [this.read.vault, this.read.usdc]) {
      try {
        const parsed = contract?.interface.parseError(typeof data === "string" ? data : data?.data);
        if (parsed) return new Revert(parsed.name);
      } catch { /* not this contract's error */ }
    }
    return error;
  },

  // Simulates, sends from the wallet and waits for one confirmation. target is "vault" or "usdc".
  async send(label, target, method, args) {
    if (!this.signer) throw new Revert("NotConnected");
    const contract = this.read[target];
    try {
      await contract.getFunction(method).staticCall(...args, { from: this.account });
    } catch (error) {
      throw this.decodeError(error);
    }
    let tx;
    try {
      tx = await contract.connect(this.signer).getFunction(method)(...args);
    } catch (error) {
      throw this.decodeError(error);
    }
    this.onTransaction?.({ label, hash: tx.hash, url: this.explorerTx(tx.hash), stage: "pending" });
    try {
      const receipt = await tx.wait(1);
      this.onTransaction?.({ label, hash: tx.hash, url: this.explorerTx(tx.hash), stage: "done" });
      return receipt;
    } catch (error) {
      this.onTransaction?.({ label, hash: tx.hash, url: this.explorerTx(tx.hash), stage: "failed" });
      throw this.decodeError(error);
    }
  },

  // Asks the deployed vault to run its price checks on a signed response: no wallet, no gas, nothing moves. Resolves with
  // the price it read and when the source took it, or throws a Revert named after the vault's error.
  async checkPrice(asset, response) {
    try {
      const [price, priceTime] = await this.read.vault.checkPrice(this.deployment.assetIds[asset], Units.signedResponseToContract(response));
      return { price: Units.priceFromWei(price), priceTime: Number(priceTime) };
    } catch (error) {
      throw this.decodeError(error);
    }
  },

  // A fresh signed price straight from Nodary: free, and it needs neither a wallet nor the agent
  async fetchSignedPrice(asset) {
    const response = await fetch(NODARY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(this.requestHashes.prices[asset].request),
    });
    if (!response.ok) throw new Error(`Nodary answered ${response.status}`);
    return response.json();
  },

  // One button of the tamper test: a real fresh ETH response, or one forgery of it built here in the browser
  async tamperCase(kind) {
    if (kind === "stale") {
      const response = await fetch("../shared/fixtures/nodary-eth-usd.json", { cache: "no-store" });
      if (!response.ok) throw new Error("the old signed response is missing");
      return response.json();
    }
    if (kind === "wrongRequest") return this.fetchSignedPrice("BTC");
    const real = await this.fetchSignedPrice("ETH");
    if (kind === "edited") return { ...real, data: real.data.replace(/"price":([\d.]+)/, (_, price) => `"price":${Number(price) * 2}`) };
    if (kind === "wrongSigner") {
      // The real data, signed the way an Airnode signs, by a key made just now
      const digest = ethers.solidityPackedKeccak256(["bytes32", "uint256", "bytes"], [real.requestHash, real.timestamp, ethers.toUtf8Bytes(real.data)]);
      return { ...real, signature: await ethers.Wallet.createRandom().signMessage(ethers.getBytes(digest)) };
    }
    return real;
  },

  // Two readers can poll at once, so they share one scan: the same log must not be stored twice
  scanLogs() {
    this.scanning ??= this.scanNewLogs().finally(() => { this.scanning = null; });
    return this.scanning;
  },

  // Reads every vault event since the deployment, in chunks the RPC accepts, and only new blocks after that
  async scanNewLogs() {
    const provider = this.read.provider, vault = this.read.vault;
    const latest = await provider.getBlockNumber();
    let from = this.scannedTo === null ? Number(this.deployment.scanFromBlock ?? this.deployment.deployedAtBlock ?? 0) : this.scannedTo + 1;
    let chunk = this.network.logChunk ?? LOG_CHUNK;
    while (from <= latest) {
      const to = Math.min(latest, from + chunk - 1);
      let raw;
      try {
        raw = await provider.getLogs({ address: this.deployment.vault, fromBlock: from, toBlock: to });
      } catch (error) {
        if (chunk > 1) { chunk = Math.max(1, Math.floor(chunk / 2)); continue; } // "block range too large"
        throw error;
      }
      for (const log of raw) {
        let parsed;
        try { parsed = vault.interface.parseLog(log); } catch { continue; }
        if (!parsed) continue;
        this.logs.push({ name: parsed.name, args: plain(parsed.args), blockNumber: log.blockNumber, txHash: log.transactionHash });
      }
      this.scannedTo = to;
      from = to + 1;
    }
    return latest;
  },

  async blockTime(blockNumber) {
    if (!this.blockTimes.has(blockNumber)) {
      const block = await this.read.provider.getBlock(blockNumber);
      this.blockTimes.set(blockNumber, Number(block.timestamp));
    }
    return this.blockTimes.get(blockNumber);
  },

  // One snapshot of everything the page shows for `user`, read from the chain
  async readState(user) {
    const v = this.read.vault, u = this.read.usdc;
    const latestBlock = await this.scanLogs();
    const [walletUsdc, allowance, vaultBalance, paused, ruleTuple, triggerCount, positionCount, block] = await Promise.all([
      u.balanceOf(user), u.allowance(user, this.deployment.vault), v.balanceOf(user), v.isPaused(user), v.getRule(user),
      v.triggerCount(), v.positionCount(), this.read.provider.getBlock(latestBlock),
    ]);
    const [ruleRaw, assetIds, watchedAccounts] = [plain(ruleTuple[0]), [...ruleTuple[1]], [...ruleTuple[2]]];
    const hasRule = ruleRaw.agent && ruleRaw.agent !== ZERO_ADDRESS;
    const keyOf = id => this.assetOfId[String(id).toLowerCase()];
    const mine = (address) => String(address).toLowerCase() === user.toLowerCase();

    const [assetRuleTuples, spent, triggerRaws, positionRaws] = await Promise.all([
      Promise.all(assetIds.map(id => v.getAssetRule(user, id))),
      Promise.all(assetIds.map(id => v.spentToday(user, id))),
      Promise.all(Array.from({ length: Number(triggerCount) }, (_, i) => v.getTrigger(i + 1))),
      Promise.all(Array.from({ length: Number(positionCount) }, (_, i) => v.getPosition(i + 1))),
    ]);

    // Topics live only in the user's latest RuleSet event
    const ruleSet = this.logs.filter(l => l.name === "RuleSet" && mine(l.args.user)).at(-1);
    const topicsByAsset = {};
    if (ruleSet) {
      ruleSet.args.assetIds.forEach((id, i) => {
        const key = keyOf(id);
        if (key) topicsByAsset[key] = String(ruleSet.args.assetTopics[i] || "").split(",").map(t => t.trim()).filter(Boolean);
      });
    }

    const opened = new Map(), confirmed = new Map(), expired = new Map(), sold = new Map(), lastPrices = {};
    const notePrice = (key, price, time) => {
      if (!key) return;
      if (!lastPrices[key] || time >= lastPrices[key].time) lastPrices[key] = { price: Units.priceFromWei(price), time };
    };
    for (const log of this.logs) {
      const a = log.args;
      if (log.name === "TriggerOpened") {
        opened.set(String(a.triggerId), { ...a, txHash: log.txHash });
        notePrice(keyOf(a.assetId), a.p0, Number(a.t0));
      } else if (log.name === "TriggerConfirmed") {
        confirmed.set(String(a.triggerId), { ...a, txHash: log.txHash });
      } else if (log.name === "TriggerExpired") {
        expired.set(String(a.triggerId), { txHash: log.txHash, blockNumber: log.blockNumber });
      } else if (log.name === "PositionSold") {
        sold.set(String(a.positionId), { ...a, txHash: log.txHash, blockNumber: log.blockNumber });
      }
    }
    // Confirmations carry no asset, so they take it from their trigger
    const triggerAsset = new Map(triggerRaws.map((t, i) => [String(i + 1), keyOf(plain(t).assetId)]));
    for (const [id, c] of confirmed) notePrice(triggerAsset.get(id), c.p1, Number(c.t1));
    for (const s of sold.values()) {
      const position = positionRaws[Number(s.positionId) - 1];
      if (position) notePrice(keyOf(plain(position).assetId), s.price, await this.blockTime(s.blockNumber));
    }

    const assetRules = {}, spentToday = {}, onchainAssetRules = [];
    assetIds.forEach((id, i) => {
      const r = plain(assetRuleTuples[i][1]);
      const normalized = Object.fromEntries(Object.entries(r).map(([k, val]) => [k, Number(val)]));
      onchainAssetRules.push(normalized);
      const key = keyOf(id);
      if (key) { assetRules[key] = normalized; spentToday[key] = Units.unitsToUsdc(spent[i]); }
    });

    const triggers = [];
    for (const [i, raw] of triggerRaws.entries()) {
      const t = plain(raw), id = String(i + 1);
      if (!mine(t.user)) continue;
      const key = keyOf(t.assetId), rule = assetRules[key] || {};
      const o = opened.get(id), c = confirmed.get(id), e = expired.get(id);
      triggers.push({
        id, asset: key, account: this.handleOfAccount[String(t.account).toLowerCase()] || null,
        tweetId: String(t.tweetId), postTime: Units.tweetTimeMs(t.tweetId),
        p0: Units.priceFromWei(t.p0), t0: Number(t.t0), status: TRIGGER_STATUS[Number(t.status)] || "none",
        opensAt: Number(t.t0) + (rule.minWait || 0), closesAt: Number(t.t0) + (rule.maxWindow || 0),
        thresholdBps: rule.thresholdBps, spikeCapBps: rule.spikeCapBps,
        p1: c ? Units.priceFromWei(c.p1) : null, t1: c ? Number(c.t1) : null,
        positionId: c ? String(c.positionId) : null,
        quoteIn: c ? Units.unitsToUsdc(c.quoteIn) : null,
        assetOut: c ? Units.tokenFromUnits(c.assetOut, this.tokenDecimals[key] ?? 18) : null,
        openTx: o?.txHash, confirmTx: c?.txHash, expireTx: e?.txHash,
        expiredAt: e ? await this.blockTime(e.blockNumber) : null,
      });
    }

    const triggerOfPosition = new Map(triggers.filter(t => t.positionId).map(t => [t.positionId, t]));
    const positions = [];
    for (const [i, raw] of positionRaws.entries()) {
      const p = plain(raw), id = String(i + 1);
      if (!mine(p.user)) continue;
      const key = keyOf(p.assetId), s = sold.get(id), decimals = this.tokenDecimals[key] ?? 18;
      positions.push({
        id, asset: key, amount: Units.tokenFromUnits(p.amount, decimals), amountUnits: BigInt(p.amount),
        cost: Units.unitsToUsdc(p.cost), entryPrice: Units.priceFromWei(p.entryPrice), openedAt: Number(p.openedAt),
        isOpen: Boolean(p.isOpen), trigger: triggerOfPosition.get(id) || null,
        exit: s ? Units.priceFromWei(s.price) : null, proceeds: s ? Units.unitsToUsdc(s.quoteOut) : null,
        sellReason: s ? SELL_REASON[Number(s.reason)] : null, soldAt: s ? await this.blockTime(s.blockNumber) : null,
        sellTx: s?.txHash,
      });
    }

    const toUsdc = n => Units.unitsToUsdc(n);
    return {
      user, chainNow: Number(block.timestamp), blockNumber: latestBlock,
      walletUsdc: toUsdc(walletUsdc), allowance: BigInt(allowance),
      vaultBalance: toUsdc(vaultBalance), vaultBalanceUnits: BigInt(vaultBalance), paused,
      rule: hasRule ? {
        agent: ruleRaw.agent, buyAmount: toUsdc(ruleRaw.buyAmount), maxPerTrade: toUsdc(ruleRaw.maxPerTrade),
        dailyLimit: toUsdc(ruleRaw.dailyLimit), assets: assetIds.map(keyOf).filter(Boolean),
        watched: watchedAccounts.map(h => this.handleOfAccount[String(h).toLowerCase()]).filter(Boolean),
      } : null,
      onchainRule: hasRule ? {
        rule: ruleRaw, assetIds, assetRules: onchainAssetRules, watchedAccounts,
        topics: assetIds.map(id => (topicsByAsset[keyOf(id)] || []).join(", ")),
      } : null,
      assetRules, topics: topicsByAsset, spentToday, triggers, positions, lastPrices,
    };
  },

  // Calls refresh every pollMs while the tab is visible
  startPolling(refresh) {
    this.stopPolling();
    this.timer = setInterval(() => { if (!document.hidden) refresh(); }, this.network.pollMs);
  },
  stopPolling() { if (this.timer) clearInterval(this.timer); this.timer = null; },
};
