# Frontend: Signal Vault

The user interface for the vault: log in, set a rule, deposit and withdraw, watch posts go through both checks, see the investment history, and run the tamper test (footer link "For judges").

## Run it

No build step. Open `index.html` in a browser, or serve the folder:

```bash
cd frontend
python3 -m http.server 8000
```

Then open http://localhost:8000.

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
