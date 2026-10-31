# Frontend: Signal Vault

The user interface for the vault: log in, set a rule, deposit and withdraw, watch posts go through both checks, see the investment history, and run the tamper test (footer link "For judges").

## Run it

No build step. Serve the **repo root**, because live mode reads `../shared/deployments/`:

```bash
python -m http.server 8000
```

Then open http://localhost:8000/frontend/. (`npx --yes serve -l 8000 .` works too, but needs a download; Python's
server needs nothing.)

The only library is ethers v6, vendored in `vendor/ethers.umd.min.js` (version and source in its first line), so the
page needs no CDN.

## Practice mode

The page currently runs in practice mode: `js/mock.js` stands in for the vault contract and the agent and runs the same checks (signer, request, freshness, replay, trend, spike cap, limits). Accounts and profiles are stored in the browser only. Calls to replace with the deployed contract are marked `TODO` in `js/app.js`.

## Files

| File | Holds |
| --- | --- |
| `index.html` | Page layout: login, tabs, footer |
| `css/style.css` | Colours and layout |
| `js/config.js` | Asset profiles, watched accounts, topics, limits |
| `js/mock.js` | Practice contract and agent |
| `js/app.js` | Everything the page does |
