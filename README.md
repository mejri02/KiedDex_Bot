# KieDex Bot

Fully automated trading bot for **KieDex** — claims rewards, solves quizzes with AI, executes trades, manages positions.

**GitHub:** [mejri02/KiedDex_Bot](https://github.com/mejri02/KiedDex_Bot)  
**Telegram:** [AirDropXDevs](https://t.me/AirDropXDevs)  
**Referral:** https://www.kiedex.app/r/376077688

---

## Features

- **Multi-account automation** — run dozens of accounts in parallel with proxy rotation
- **Daily claims** — faucet, oil bonus, KDX earnings
- **AI quiz solver** — Groq API integration for automatic quiz submissions (+KDX rewards)
- **Futures trading** — open long positions with TP/SL, auto-close on profit/loss/age
- **Position management** — automatic liquidation checks, stale position closing
- **Risk controls** — margin/leverage limits, minimum balance checks, circuit breaker
- **Proxy support** — HTTP/HTTPS/SOCKS5, sticky per-account, auto-rotation, blacklist on fail
- **Webhooks** — Discord & Telegram notifications (margin calls, trade fills, cycle summaries)
- **Logging** — per-day logs + JSON run reports, 7-day rotation
- **Dry-run mode** — test all logic without executing trades

---

## Setup

### 0. Clone Repository

```bash
git clone https://github.com/mejri02/KiedDex_Bot.git
cd KiedDex_Bot
```

### 1. Install

```bash
npm install
# or
yarn install
```

### 2. Configure

Edit `config.json` (auto-created on first run):

```json
{
  "ai": {
    "enabled": true,
    "groq_api_key": "gsk_YOUR_GROQ_KEY_HERE",
    "model": "openai/gpt-oss-120b",
    "max_tokens": 512,
    "temperature": 0.0
  },
  "features": {
    "quiz": true,
    "quiz_auto_submit": true,
    "quiz_use_ai": true,
    "faucet": true,
    "oil": true,
    "trade": true,
    "daily_kdx": true
  },
  "trade": {
    "enabled": true,
    "symbols": ["BTCUSDT"],
    "leverage": 1,
    "margin_source": "oil",
    "margin_pct": 100,
    "tp_pct": 5.0,
    "sl_pct": 2.0,
    "max_open_positions": 1,
    "daily_trades": 3,
    "cycle_gap_minutes": 480,
    "auto_close_enabled": true,
    "auto_close_after_hours": 8
  },
  "risk": {
    "min_oil": 5,
    "min_usdt": 5,
    "auto_exchange_eth_to_oil": true,
    "min_oil_trigger_exchange": 10
  },
  "proxy": {
    "preflight_check": true,
    "sticky_per_account": true,
    "rotate_on_http_error": true,
    "blacklist_after_fails": 3
  },
  "webhooks": {
    "discord_url": "https://discord.com/api/webhooks/YOUR_WEBHOOK",
    "telegram_bot_token": "YOUR_BOT_TOKEN",
    "telegram_chat_id": "YOUR_CHAT_ID",
    "notify_on": ["margin_call", "refresh_failed", "cycle_summary", "crash", "close_trade", "quiz_failed"]
  }
}
```

### 3. Add Accounts

Create `accounts.json`:

```json
[
  {
    "email": "account1@example.com",
    "access_token": "eyJhbGc...",
    "refresh_token": "refresh..."
  },
  {
    "email": "account2@example.com",
    "access_token": "eyJhbGc...",
    "refresh_token": "refresh..."
  }
]
```

Extract tokens from KieDex browser dev tools (`Application > Local Storage > supabase.auth.token`).

**Example:** Open DevTools → **Application** tab → **Local Storage** → Click **https://kiedex.app** → Find `sb-fcrszbwbuzhbovyloam-auth-token` key containing access/refresh tokens:

![Token Extraction Example](token-extraction-example.png)

### 4. Add Proxies (Optional)

Create `proxy.txt` (one per line):

```
http://user:pass@proxy1.com:8080
http://user:pass@proxy2.com:8080
socks5://proxy3.com:1080
```

### 5. AI Quiz Solver (Optional)

Get a free Groq API key: https://console.groq.com

Set `groq_api_key` in `config.json`. Bot will auto-solve quizzes with chain-of-thought reasoning.

---

## Run

```bash
# Interactive mode (choose proxy/no-proxy)
node index.js

# Run without proxy
node index.js --no-menu --no-proxy

# Run with proxy
node index.js --no-menu

# Verbose logging
node index.js --verbose

# Quiet mode (errors & summary only)
node index.js --quiet
```

---

## How It Works

### Trading Cycle

Each cycle processes all accounts in order:

1. **Connection check** — verify proxy connectivity
2. **Token refresh** — auto-renew JWT if needed
3. **Balances & tier** — fetch current state
4. **Faucet/Oil claims** — auto-claim if available
5. **Quiz task** — solve + submit if active (Groq AI)
6. **Daily KDX** — claim yesterday's earnings
7. **Risk checks** — ETH→OIL swap, Spot→Futures transfer
8. **Auto-close** — liquidate stale/profit/loss positions
9. **Trade** — open new long if conditions met

### Quiz Solving

If enabled:
- Fetches active quiz via RPC
- Sends question + options to Groq
- Groq applies financial reasoning (funding rates, basis, PnL, etc.)
- Bot submits answer, logs result to `quiz_log.json`

### Position Management

Auto-closes if any trigger hits:
- **Profit target:** `auto_close_on_profit_pct`
- **Stop loss:** `auto_close_on_loss_pct`
- **Max age:** `auto_close_after_hours`
- **Before reopen:** if `close_before_reopen: true`

---

## Reports

After each cycle:

- **Console summary** — accounts processed, claims, trades, realized PnL
- **`logs/YYYY-MM-DD.log`** — full transcript
- **`logs/run_cN_TIMESTAMP.json`** — detailed run report per cycle

Quiz submissions logged to `quiz_log.json` (last 500 entries).

---

## Notifications

**Discord & Telegram** on:
- `margin_call` — liquidation risk
- `refresh_failed` — token expiry
- `cycle_summary` — end of cycle stats
- `crash` — fatal errors
- `close_trade` — position closures
- `quiz_failed` — solver errors

Configure in `config.json` → `webhooks`.

---

## Tips

- **Start with 1 account** — verify setup before scaling
- **Test dry-run first** — set `trade.dry_run: true`, then flip to `false`
- **Monitor logs** — check `logs/` for errors
- **Rotate proxies** — use `sticky_per_account: true` to avoid re-auth loops
- **Adjust margins** — lower `margin_pct` if hitting oil limits
- **Set webhooks early** — catch crashes in real-time

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| `HTTP 401: invalid JWT` | Token expired; ensure `refresh_token` in accounts.json |
| `Proxy connection failed` | Verify proxy format & connectivity; check `proxy.txt` |
| `Quiz solver timeout` | Increase `ai.timeout_ms` in config |
| `Low margin / low oil` | Reduce `trade.margin_pct` or wait for claim |
| `Circuit breaker tripped` | Reduce `runtime.circuit_breaker_pct` threshold |

---

## License

MIT

---

**Questions?** Join the Telegram: [AirDropXDevs](https://t.me/AirDropXDevs)
