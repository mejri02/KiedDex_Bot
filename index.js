import fs from "fs";
import path from "path";
import axios from "axios";
import chalk from "chalk";
import jwt from "jsonwebtoken";
import readline from "readline";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

const GROQ_SYSTEM_PROMPT = `You are a precise financial quiz solver for a crypto trading platform (KieDex).
You will receive a multiple-choice question about crypto, trading, derivatives, arbitrage, funding rates, collateral haircuts, or blockchain.

Return ONLY a single lowercase letter: a, b, c, or d.
Do not explain. Do not add punctuation. Do not add quotes. Just one letter.

Think carefully before answering:
- Funding rate: paid every 8h, so N days = 3N payments. Funding PnL = position_notional × rate × periods.
- Spot/perp arbitrage: total PnL = spot PnL + perp PnL + funding.
- PnL math: (exit - entry) * size * direction.
- Long spot + short perp = delta-neutral.
- Leverage: required margin = notional / leverage.
- Collateral haircut: effective value = quantity × price × (1 − haircut_pct/100).
- APR vs APY: APY = (1 + APR/n)^n − 1.
- Options: intrinsic = max(0, S−K) calls, max(0, K−S) puts.
- Basis = perp − spot.

Recompute the numbers mentally before answering. Do not guess.`;

class QuizSolver {
    constructor(config, logger) {
        this.cfg = config.ai || {};
        this.features = config.features || {};
        this.logger = logger;
        this.cache = new Map();
    }
    isEnabled() {
        return (
            this.features.quiz === true &&
            this.features.quiz_use_ai === true &&
            this.cfg.enabled !== false &&
            typeof this.cfg.groq_api_key === "string" &&
            this.cfg.groq_api_key.startsWith("gsk_")
        );
    }
    _buildUserPrompt(quiz) {
        const opts = (quiz.options || []).map(o => `  ${o.key}) ${o.label}`).join("\n");
        return `Question:\n${quiz.question}\n\nOptions:\n${opts}\n\nAnswer (single letter):`;
    }
    _extractLetter(text, validKeys, options = null) {
        if (!text) return null;
        const cleaned = String(text).trim().toLowerCase();
        const strict = cleaned.match(/^([a-d])\b/);
        if (strict && validKeys.includes(strict[1])) return strict[1];
        for (const ch of cleaned) if (validKeys.includes(ch)) return ch;
        if (Array.isArray(options) && options.length > 0) {
            const numMatch = cleaned.match(/-?\d[\d,]*\.?\d*/g);
            if (numMatch) {
                for (const raw of numMatch) {
                    const num = parseFloat(raw.replace(/,/g, ""));
                    if (isNaN(num)) continue;
                    for (const o of options) {
                        const label = String(o.label || "");
                        const optNums = label.match(/-?\d[\d,]*\.?\d*/g) || [];
                        for (const on of optNums) {
                            const optVal = parseFloat(on.replace(/,/g, ""));
                            if (isNaN(optVal)) continue;
                            if (Math.abs(optVal - num) / Math.max(1, Math.abs(optVal)) < 1e-4) {
                                return String(o.key).toLowerCase();
                            }
                        }
                    }
                }
            }
        }
        return null;
    }
    async _callGroq(model, prompt, timeoutMs) {
        const body = {
            model,
            messages: [
                { role: "system", content: GROQ_SYSTEM_PROMPT },
                { role: "user", content: prompt }
            ],
            max_tokens: this.cfg.max_tokens || 512,
            temperature: this.cfg.temperature ?? 0.0,
            stream: false,
            reasoning_effort: this.cfg.reasoning_effort || "low",
            include_reasoning: false
        };
        const res = await axios.post(GROQ_URL, body, {
            timeout: timeoutMs,
            headers: {
                "Authorization": `Bearer ${this.cfg.groq_api_key}`,
                "Content-Type": "application/json"
            },
            validateStatus: () => true
        });
        if (res.status >= 400) {
            const msg = res.data?.error?.message || JSON.stringify(res.data).slice(0, 200);
            throw new Error(`Groq HTTP ${res.status}: ${msg}`);
        }
        const choice = res.data?.choices?.[0] || {};
        const msg = choice.message || {};
        const content = msg.content ?? "";
        const reasoning = msg.reasoning ?? "";
        this.logger.debug(
            `Groq raw [${model}] finish=${choice.finish_reason} content_len=${content.length} ` +
            `reasoning_len=${reasoning.length}`
        );
        return content || reasoning || "";
    }
    async solve(quiz) {
        if (!this.isEnabled()) return null;
        if (!quiz?.question || !Array.isArray(quiz.options) || quiz.options.length === 0) {
            this.logger.warn("Quiz solver: malformed payload");
            return null;
        }
        const validKeys = quiz.options.map(o => String(o.key).toLowerCase());
        const cacheKey = `${quiz.id || ""}::${quiz.question}`;
        if (this.cache.has(cacheKey)) return this.cache.get(cacheKey);
        const prompt = this._buildUserPrompt(quiz);
        const timeoutMs = this.cfg.timeout_ms || 20000;
        const primary = this.cfg.model || "openai/gpt-oss-120b";
        const fallback = this.cfg.fallback_model || "openai/gpt-oss-20b";
        for (const model of [primary, fallback]) {
            if (!model) continue;
            try {
                const raw = await this._callGroq(model, prompt, timeoutMs);
                const letter = this._extractLetter(raw, validKeys, quiz.options);
                if (letter) {
                    this.cache.set(cacheKey, letter);
                    this.logger.info(`Quiz solver: ${model} → "${letter}"`);
                    return letter;
                }
            } catch (e) {
                this.logger.warn(`Quiz solver: ${model} failed: ${e.message}`);
            }
        }
        this.logger.error("Quiz solver: all models failed");
        return null;
    }
}

const BASE_API = "https://ydvdknhjrdjyfjbuobvi.supabase.co";
const API_KEY  = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlkdmRrbmhqcmRqeWZqYnVvYnZpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI3MTU5MTYsImV4cCI6MjA5ODI5MTkxNn0.o3h3_77oLmhUPJuHzIpbtxS6Eo4iaQfnT-D51GvkDyQ";
const ORIGIN   = "https://www.kiedex.app";
const REFERER  = "https://www.kiedex.app/";

const FILE_ACCOUNTS  = "accounts.json";
const FILE_PROXIES   = "proxy.txt";
const FILE_CONFIG    = "config.json";
const FILE_APROXIES  = "account_proxies.json";
const FILE_QUIZ_LOG  = "quiz_log.json";
const DIR_LOGS       = "logs";

const TOKEN_REFRESH_MARGIN_SEC = 300;
const OIL_FEE_MULTIPLIER       = 1.5;

const USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
];

const EMOJI = {
    rocket: "🚀", fire: "🔥", money: "💰", coin: "🪙", oil: "🛢️",
    chart: "📈", lock: "🔐", check: "✅", cross: "❌", warn: "⚠️",
    clock: "⏰", bot: "🤖", user: "👤", globe: "🌐", gift: "🎁",
    target: "🎯", bolt: "⚡", hourglass: "⏳", refresh: "🔄",
    shield: "🛡️", arrow: "➜", dot: "•", star: "⭐", gem: "💎",
    party: "🎉", link: "🔗", spark: "✨", wave: "🌊"
};

const DEFAULT_CONFIG = {
    ai: {
        enabled: true, provider: "groq", groq_api_key: "",
        model: "openai/gpt-oss-120b", fallback_model: "openai/gpt-oss-20b",
        max_tokens: 512, temperature: 0.0, timeout_ms: 20000,
        reasoning_effort: "low"
    },
    features: {
        faucet: true, oil: true, social_tasks: true, trade: true,
        eth_to_oil: true, usdt_transfer: true, tier_display: true,
        airdrop_stats: true, season1_check: true, staking_claim: true,
        notifications_mark_read: true,
        daily_kdx: true,
        quiz: true, quiz_auto_submit: true, quiz_use_ai: true,
        quiz_log_path: FILE_QUIZ_LOG
    },
    trade: {
        enabled: true, symbols: ["BTCUSDT"], leverage: 1,
        margin_mode: "isolated", margin_source: "oil", margin_pct: 100,
        fixed_margin: 10, max_margin_per_order: 100,
        tp_pct: 5.0, sl_pct: 2.0, max_open_positions: 1, dry_run: false,
        daily_trades: 3, cycle_gap_minutes: 480,
        auto_close_enabled: true, auto_close_after_hours: 8,
        auto_close_on_profit_pct: 2.0, auto_close_on_loss_pct: 3.0,
        close_before_reopen: true, close_timeout_ms: 25000,
        close_reason_tag: "bot_auto_close",
        daily_kdx_use_yesterday: true
    },
    risk: {
        min_oil: 5, min_usdt: 5,
        auto_exchange_eth_to_oil: true, min_oil_trigger_exchange: 10,
        min_eth_to_exchange: 0.0005,
        auto_transfer_spot_to_futures: true, min_futures_usdt: 5
    },
    proxy: {
        preflight_check: true, sticky_per_account: true,
        rotate_on_http_error: true, blacklist_after_fails: 3
    },
    webhooks: {
        discord_url: "", telegram_bot_token: "", telegram_chat_id: "",
        notify_on: ["margin_call", "refresh_failed", "cycle_summary", "crash", "close_trade", "quiz_failed"]
    },
    runtime: {
        max_retries: 5, inter_account_delay_min: 3,
        inter_account_delay_max: 8, circuit_breaker_pct: 50
    }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => Math.random() * (max - min) + min;
const randUA = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
const logStamp = () => new Date().toLocaleString("en-GB");
const todayDate = () => new Date().toISOString().slice(0, 10);
const yesterdayDate = () => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
};

function fmtSeconds(s) {
    const h = String(Math.floor(s / 3600)).padStart(2, "0");
    const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
    const sec = String(s % 60).padStart(2, "0");
    return `${h}:${m}:${sec}`;
}
function maskEmail(email) {
    if (!email || !email.includes("@")) return "N/A";
    const [l, d] = email.split("@");
    if (l.length <= 6) return `${l.slice(0, 2)}***@${d}`;
    return `${l.slice(0, 3)}***${l.slice(-3)}@${d}`;
}
function deepMerge(base, over) {
    const out = { ...base };
    for (const k of Object.keys(over || {})) {
        if (out[k] && typeof out[k] === "object" && !Array.isArray(out[k]) &&
            typeof over[k] === "object" && !Array.isArray(over[k])) {
            out[k] = deepMerge(out[k], over[k]);
        } else out[k] = over[k];
    }
    return out;
}
function loadJSON(file, fallback) {
    try {
        if (!fs.existsSync(file)) return fallback;
        const raw = fs.readFileSync(file, "utf-8");
        if (!raw.trim()) return fallback;
        return JSON.parse(raw);
    } catch { return fallback; }
}
function saveJSONAtomic(file, data) {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 4));
    fs.renameSync(tmp, file);
}
function loadConfig() {
    if (!fs.existsSync(FILE_CONFIG)) {
        fs.writeFileSync(FILE_CONFIG, JSON.stringify(DEFAULT_CONFIG, null, 4));
        return DEFAULT_CONFIG;
    }
    return deepMerge(DEFAULT_CONFIG, loadJSON(FILE_CONFIG, {}));
}
function argFlag(name) { return process.argv.includes(name); }

class Logger {
    constructor(config, verbose = false, quiet = false) {
        this.cfg = config; this.verbose = verbose; this.quiet = quiet;
        if (!fs.existsSync(DIR_LOGS)) fs.mkdirSync(DIR_LOGS, { recursive: true });
        this.file = path.join(DIR_LOGS, `${todayDate()}.log`);
        this.stream = fs.createWriteStream(this.file, { flags: "a" });
        this.purgeOld();
    }
    purgeOld() {
        try {
            const files = fs.readdirSync(DIR_LOGS).filter(f => f.endsWith(".log")).sort();
            const excess = files.slice(0, Math.max(0, files.length - 7));
            for (const f of excess) fs.unlinkSync(path.join(DIR_LOGS, f));
        } catch {}
    }
    _write(level, colorFn, msg) {
        const line = `[ ${logStamp()} ] [${level}] ${msg}`;
        try { this.stream.write(line + "\n"); } catch {}
        if (this.quiet && !["SUMMARY", "CRITICAL", "ERROR"].includes(level)) return;
        console.log(`[ ${logStamp()} ] ${colorFn(msg)}`);
    }
    info(m)     { this._write("INFO", chalk.white, m); }
    ok(m)       { this._write("OK", chalk.greenBright, m); }
    warn(m)     { this._write("WARN", chalk.yellowBright, m); }
    error(m)    { this._write("ERROR", chalk.redBright, m); }
    critical(m) { this._write("CRITICAL", chalk.bgRed.white, m); }
    debug(m)    { if (this.verbose) this._write("DEBUG", chalk.magentaBright, m); }
    summary(m)  { this._write("SUMMARY", chalk.cyanBright, m); }
    accountStart(idx, total, email) {
        const sep = "═".repeat(23);
        console.log(chalk.cyanBright.bold(`\n${sep} [ ${idx} / ${total} ] ${sep}`));
        this.info(`${EMOJI.user} Account: ${chalk.whiteBright(maskEmail(email))}`);
    }
    banner() {
        const art = [
            " ██  ██ ██ ███████ ██████  ███████ ██  ██ ",
            " ██ ██  ██ ██      ██   ██ ██       ████  ",
            " ████   ██ █████   ██   ██ █████     ██   ",
            " ██ ██  ██ ██      ██   ██ ██       ██ ██ ",
            " ██  ██ ██ ███████ ██████  ███████ ██  ██ "
        ].join("\n");
        console.log(chalk.greenBright.bold("\n" + art + "\n"));
        console.log(chalk.cyanBright(`           ⚡  Auto BOT v1  •  ${EMOJI.rocket}\n`));
    }
    close() { try { this.stream.end(); } catch {} }
}

class Webhook {
    constructor(config, logger) { this.cfg = config.webhooks || {}; this.logger = logger; }
    async send(event, text) {
        if (!(this.cfg.notify_on || []).includes(event)) return;
        const body = `*[KieDex Bot]* ${EMOJI.bolt} ${event}\n${text}`;
        await Promise.allSettled([this._discord(body), this._telegram(body)]);
    }
    async _discord(t) {
        if (!this.cfg.discord_url) return;
        try { await axios.post(this.cfg.discord_url, { content: t }, { timeout: 8000 }); }
        catch (e) { this.logger.debug(`discord failed: ${e.message}`); }
    }
    async _telegram(t) {
        if (!this.cfg.telegram_bot_token || !this.cfg.telegram_chat_id) return;
        try {
            const url = `https://api.telegram.org/bot${this.cfg.telegram_bot_token}/sendMessage`;
            await axios.post(url, { chat_id: this.cfg.telegram_chat_id, text: t, parse_mode: "Markdown" }, { timeout: 8000 });
        } catch (e) { this.logger.debug(`telegram failed: ${e.message}`); }
    }
}

class ProxyManager {
    constructor(config, logger) {
        this.cfg = config.proxy || {}; this.logger = logger;
        this.proxies = []; this.stats = new Map();
        this.accountProxies = new Map(); this.index = 0;
        this.load(); this.loadSticky();
    }
    load() {
        if (!fs.existsSync(FILE_PROXIES)) return;
        const lines = fs.readFileSync(FILE_PROXIES, "utf-8")
            .split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        this.proxies = lines;
        for (const p of lines) {
            if (!this.stats.has(p)) this.stats.set(p, { alive: true, failCount: 0, lastError: "" });
        }
        if (this.proxies.length > 0) this.logger.info(`${EMOJI.globe} Proxies loaded: ${chalk.whiteBright(this.proxies.length)}`);
    }
    loadSticky() {
        if (!this.cfg.sticky_per_account) return;
        const data = loadJSON(FILE_APROXIES, {});
        for (const [e, u] of Object.entries(data)) this.accountProxies.set(e, u);
    }
    saveSticky() {
        if (!this.cfg.sticky_per_account) return;
        const obj = {};
        for (const [e, u] of this.accountProxies.entries()) obj[e] = u;
        saveJSONAtomic(FILE_APROXIES, obj);
    }
    normalize(p) {
        const s = ["http://", "https://", "socks4://", "socks5://"];
        return s.some(x => p.startsWith(x)) ? p : `http://${p}`;
    }
    buildAgent(u) {
        if (!u) return null;
        const n = this.normalize(u);
        return n.startsWith("socks") ? new SocksProxyAgent(n) : new HttpsProxyAgent(n);
    }
    isAlive(u) { const s = this.stats.get(u); return s ? s.alive : true; }
    recordFail(u, e) {
        const s = this.stats.get(u); if (!s) return;
        s.failCount++; s.lastError = e || "";
        if (s.failCount >= (this.cfg.blacklist_after_fails || 3)) s.alive = false;
    }
    recordSuccess(u) { const s = this.stats.get(u); if (s) s.failCount = 0; }
    nextForAccount(e) {
        if (!this.cfg.sticky_per_account) return this._next();
        if (this.accountProxies.has(e)) {
            const c = this.accountProxies.get(e);
            if (this.isAlive(c)) return c;
        }
        const p = this._next();
        if (p) { this.accountProxies.set(e, p); this.saveSticky(); }
        return p;
    }
    rotateForAccount(e) {
        const p = this._next();
        if (p) { this.accountProxies.set(e, p); this.saveSticky(); }
        return p;
    }
    _next() {
        if (!this.proxies.length) return null;
        for (let i = 0; i < this.proxies.length; i++) {
            const u = this.proxies[this.index];
            this.index = (this.index + 1) % this.proxies.length;
            if (this.isAlive(u)) return this.normalize(u);
        }
        return null;
    }
    async preflight() {
        if (!this.cfg.preflight_check || !this.proxies.length) return;
        this.logger.info(`${EMOJI.bolt} Pre-flight checking ${this.proxies.length} proxies...`);
        const tasks = this.proxies.map(async (raw) => {
            const url = this.normalize(raw);
            const agent = this.buildAgent(url);
            try {
                await axios.get("https://api.ipify.org?format=json", {
                    timeout: 10000, httpsAgent: agent, proxy: false
                });
                this.recordSuccess(raw); return true;
            } catch (e) { this.recordFail(raw, e.message); return false; }
        });
        const results = await Promise.all(tasks);
        const alive = results.filter(Boolean).length;
        this.logger.ok(`${EMOJI.check} Proxies alive: ${chalk.greenBright(alive)} / ${results.length}`);
    }
}

class Http {
    constructor(config, logger) {
        this.cfg = config; this.logger = logger;
        this.maxRetries = config.runtime?.max_retries || 5;
    }
    async request(method, url, { proxyAgent, headers, params, data, timeout = 60000 }, retries = null) {
        const max = retries ?? this.maxRetries;
        let lastErr;
        for (let attempt = 0; attempt < max; attempt++) {
            try {
                const res = await axios.request({
                    method, url,
                    httpsAgent: proxyAgent || undefined,
                    proxy: false,
                    timeout, headers, params,
                    data: data !== undefined ? JSON.stringify(data) : undefined,
                    validateStatus: () => true
                });
                if (res.status >= 400) {
                    const err = new Error(`HTTP ${res.status}: ${JSON.stringify(res.data).slice(0, 200)}`);
                    err.response = res;
                    throw err;
                }
                return res;
            } catch (e) {
                lastErr = e;
                if (attempt < max - 1) {
                    const backoff = Math.min(60, Math.pow(2, attempt) + rand(0, 1));
                    await sleep(backoff * 1000);
                    continue;
                }
            }
        }
        throw lastErr;
    }
}

class KieDexBot {
    constructor(config, logger, webhook, proxyMgr, options = {}) {
        this.cfg = config;
        this.logger = logger;
        this.webhook = webhook;
        this.proxy = proxyMgr;
        this.http = new Http(config, logger);

        this.quizSolver = new QuizSolver(config, logger);
        if (config.features?.quiz && config.features?.quiz_auto_submit) {
            if (this.quizSolver.isEnabled()) logger.ok(`🤖 Groq quiz solver enabled (${config.ai.model})`);
            else logger.warn(`⚠️ Quiz enabled but Groq solver is NOT configured`);
        }

        this.verbose = options.verbose || false;
        this.accounts = new Map();
        this.shutdown = false;
        this.useProxy = options.useProxy !== false;

        this.report = this._newReport();

        process.on("SIGINT", () => {
            if (this.shutdown) process.exit(1);
            this.shutdown = true;
            this.logger.warn(`${EMOJI.warn} SIGINT — finishing current account...`);
        });
    }

    _newReport() {
        return {
            started_at: new Date().toISOString(),
            accounts_total: 0, accounts_ok: 0, accounts_failed: 0,
            faucet_claimed: 0, bonus_claimed: 0,
            kdx_claims_ok: 0, kdx_total_claimed: 0,
            tasks_completed: 0, trades_opened: 0,
            positions_closed: 0, realized_pnl: 0, close_errors: 0,
            quizzes_submitted: 0,
            total_kdx_earned: 0, per_account: []
        };
    }

    baseHeaders() {
        return {
            "Accept": "*/*",
            "Accept-Language": "en-GB,en;q=0.9",
            "Apikey": API_KEY,
            "Cache-Control": "no-cache",
            "Origin": ORIGIN,
            "Pragma": "no-cache",
            "Referer": REFERER,
            "User-Agent": randUA(),
            "X-Client-Info": "supabase-js-web/2.106.2"
        };
    }
    authHeaders(email) {
        const h = this.baseHeaders();
        h["Authorization"] = `Bearer ${this.accounts.get(email).access_token}`;
        return h;
    }
    rpcHeaders(email) {
        const h = this.authHeaders(email);
        h["Content-Profile"] = "public";
        h["Content-Type"] = "application/json";
        return h;
    }
    tableReadHeaders(email) {
        const h = this.authHeaders(email);
        h["Accept-Profile"] = "public";
        return h;
    }

    decodeToken(email) {
        try {
            const d = jwt.decode(this.accounts.get(email).access_token);
            return { userId: d.sub, expTime: d.exp };
        } catch { return null; }
    }
    needsRefresh(email) {
        const d = this.decodeToken(email);
        if (!d) return true;
        return Math.floor(Date.now() / 1000) + TOKEN_REFRESH_MARGIN_SEC > d.expTime;
    }
    async refreshToken(email, proxyAgent) {
        const rt = this.accounts.get(email).refresh_token;
        const url = `${BASE_API}/auth/v1/token?grant_type=refresh_token`;
        const headers = {
            "Accept": "*/*",
            "Apikey": API_KEY,
            "Content-Type": "application/json",
            "User-Agent": randUA(),
            "X-Client-Info": "supabase-js-web/2.106.2"
        };
        const res = await this.http.request("POST", url, { proxyAgent, headers, data: { refresh_token: rt } });
        return res.data;
    }
    async ensureFreshToken(email, proxyAgent) {
        if (!this.needsRefresh(email)) return true;
        try {
            this.logger.info(`${EMOJI.refresh} Refreshing token for ${maskEmail(email)}`);
            const d = await this.refreshToken(email, proxyAgent);
            if (!d?.access_token) throw new Error("no access_token");
            this.accounts.get(email).access_token = d.access_token;
            this.accounts.get(email).refresh_token = d.refresh_token;
            this.saveAccounts();
            this.logger.ok(`${EMOJI.refresh} Token refreshed`);
            return true;
        } catch (e) {
            const msg = String(e.message || "").toLowerCase();
            if (msg.includes("already_used") || msg.includes("already used")) {
                this.logger.critical(`${EMOJI.cross} Refresh token already used — re-login to KieDex and update accounts.json`);
                this.webhook.send("refresh_failed", `${email}: refresh_token_already_used`);
            } else {
                this.logger.error(`${EMOJI.cross} Refresh failed: ${e.message}`);
                this.webhook.send("refresh_failed", `${email}: ${e.message}`);
            }
            return false;
        }
    }

    loadAccounts() { const raw = loadJSON(FILE_ACCOUNTS, []); return Array.isArray(raw) ? raw : []; }
    saveAccounts() {
        const arr = Array.from(this.accounts.entries()).map(([email, v]) => ({
            email, access_token: v.access_token, refresh_token: v.refresh_token
        }));
        saveJSONAtomic(FILE_ACCOUNTS, arr);
    }

    async apiGet(email, table, params, proxyAgent) {
        const qs = new URLSearchParams(params).toString();
        const url = `${BASE_API}/rest/v1/${table}?${qs}`;
        try {
            const res = await this.http.request("GET", url, { proxyAgent, headers: this.tableReadHeaders(email) });
            return res.data;
        } catch (e) {
            this.logger.debug(`GET ${table} failed: ${e.response?.data?.message || e.message}`);
            return null;
        }
    }
    async apiRpc(email, fn, payload, proxyAgent) {
        const url = `${BASE_API}/rest/v1/rpc/${fn}`;
        try {
            const res = await this.http.request("POST", url, { proxyAgent, headers: this.rpcHeaders(email), data: payload });
            return res.data;
        } catch (e) {
            const msg = e.response?.data?.message || e.response?.data?.error || e.message;
            this.logger.debug(`RPC ${fn} failed: ${msg}`);
            return { __rpc_error: msg };
        }
    }

    async getBalances(email, agent) {
        const d = await this.apiGet(email, "balances", {
            select: "demo_usdt_balance,spot_usdt_balance,futures_usdt_balance,oil_balance,oil_locked,kdx_balance,kdx_claimable,eth_balance,eth_staked",
            user_id: `eq.${this.accounts.get(email).user_id}`
        }, agent);
        return Array.isArray(d) ? d[0] : d;
    }
    async getTier(email, agent) {
        const d = await this.apiGet(email, "user_tiers", {
            select: "tier_id,tiers(name)",
            user_id: `eq.${this.accounts.get(email).user_id}`
        }, agent);
        return Array.isArray(d) && d[0] ? d[0] : null;
    }
    async getTradingStreak(email, agent) {
        return this.apiGet(email, "trading_streaks", {
            select: "current_streak",
            user_id: `eq.${this.accounts.get(email).user_id}`
        }, agent);
    }
    async getLeaderboardToday(email, agent) {
        return this.apiGet(email, "leaderboard_daily", {
            select: "trade_count,total_counted_volume,win_count",
            user_id: `eq.${this.accounts.get(email).user_id}`,
            date: `eq.${todayDate()}`
        }, agent);
    }
    async getLeaderboardForDate(email, agent, dateStr) {
        return this.apiGet(email, "leaderboard_daily", {
            select: "final_kdx_earned,base_kdx_earned,tier_bonus_kdx,tier,futures_counted_volume,spot_counted_volume",
            user_id: `eq.${this.accounts.get(email).user_id}`,
            date: `eq.${dateStr}`
        }, agent);
    }
    async getOpenPositions(email, symbol, agent) {
        const params = {
            select: "id,symbol,margin,side,entry_price,leverage,margin_mode,liquidation_price,take_profit,stop_loss,opened_at",
            user_id: `eq.${this.accounts.get(email).user_id}`
        };
        if (symbol) params.symbol = `eq.${symbol}`;
        return this.apiGet(email, "open_positions", params, agent);
    }
    async getMyOpenPositions(email, agent) { return this.getOpenPositions(email, null, agent); }
    async getLimitOrders(email, agent) {
        return this.apiGet(email, "limit_orders", {
            select: "*",
            user_id: `eq.${this.accounts.get(email).user_id}`,
            status: "eq.pending"
        }, agent);
    }
    async getPrice(symbol, agent) {
        try {
            const res = await axios.get(`https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`,
                { timeout: 10000, httpsAgent: agent || undefined, proxy: false });
            return Number(res.data.lastPrice);
        } catch { return null; }
    }

    async claimFaucet(email, agent) { return this.apiRpc(email, "claim_daily_faucet", {}, agent); }
    async claimOil(email, agent)    { return this.apiRpc(email, "claim_daily_oil", {}, agent); }
    async claimDailyKdx(email, agent, dateStr) {
        return this.apiRpc(email, "claim_daily_kdx", { p_date: dateStr }, agent);
    }
    async exchangeEthForOil(email, ethAmount, agent) {
        return this.apiRpc(email, "exchange_eth_for_oil", { p_eth_amount: ethAmount }, agent);
    }
    async transferUsdt(email, from, to, amount, agent) {
        return this.apiRpc(email, "transfer_usdt", { p_from: from, p_to: to, p_amount: amount }, agent);
    }

    async executeTradeRpc(email, payload, agent) {
        const rpcPayload = {
            p_symbol: payload.symbol,
            p_side: payload.side,
            p_margin: payload.margin,
            p_leverage: payload.leverage,
            p_entry_price: payload.entry_price,
            p_skip_oil_deduct: false,
            p_margin_mode: payload.margin_mode || "isolated"
        };
        if (payload.take_profit != null) rpcPayload.p_take_profit = payload.take_profit;
        if (payload.stop_loss != null) rpcPayload.p_stop_loss = payload.stop_loss;
        return await this.apiRpc(email, "open_trade_atomic", rpcPayload, agent);
    }

    computePnl(entry, current, side, margin, leverage) {
        const dir = String(side).toLowerCase() === "short" ? -1 : 1;
        const pnl = ((current - entry) / entry) * dir * margin * leverage;
        const pnlPct = margin > 0 ? (pnl / margin) * 100 : 0;
        return { pnl, pnlPct };
    }

    async closePosition(email, position, exitPrice, agent) {
        const markPrice = await this.getPrice(position.symbol, agent);
        let finalExit = exitPrice;
        if (markPrice && markPrice > 0) {
            if (Math.abs(markPrice - exitPrice) / markPrice > 0.10) {
                this.logger.warn(`${EMOJI.warn} Close: exit drifted >10% — using mark`);
                finalExit = markPrice;
            }
        }
        const timeoutMs = this.cfg.trade?.close_timeout_ms || 25000;
        const rpcCall = this.apiRpc(email, "close_trade_atomic", {
            p_position_id: position.id, p_exit_price: finalExit
        }, agent);
        const timeout = new Promise((_, rej) =>
            setTimeout(() => rej(new Error(`Close timed out after ${timeoutMs}ms`)), timeoutMs));
        let r;
        try { r = await Promise.race([rpcCall, timeout]); }
        catch (e) { return { ok: false, error: e.message }; }
        if (r && !r.__rpc_error && r.success !== false) {
            return { ok: true, pnl: Number(r.pnl ?? 0), response: r };
        }
        return { ok: false, error: r?.__rpc_error || r?.error || "unknown", response: r };
    }

    async _closeStalePositions(email, agent, report) {
        const cfg = this.cfg.trade || {};
        if (!cfg.auto_close_enabled) return;
        const positions = await this.getMyOpenPositions(email, agent);
        if (!Array.isArray(positions) || positions.length === 0) {
            this.logger.debug("Close-check: no open positions");
            return;
        }
        this.logger.info(`${EMOJI.chart} Close-check: ${positions.length} open position(s)`);
        for (const pos of positions) {
            const margin   = Number(pos.margin || 0);
            const leverage = Number(pos.leverage || 1);
            const entry    = Number(pos.entry_price || 0);
            const side     = String(pos.side || "long").toLowerCase();
            const openedAt = pos.opened_at ? new Date(pos.opened_at).getTime() : Date.now();
            const ageHours = (Date.now() - openedAt) / 3_600_000;
            if (!margin || !entry) continue;
            const current = await this.getPrice(pos.symbol, agent);
            if (!current) continue;
            const { pnl, pnlPct } = this.computePnl(entry, current, side, margin, leverage);
            this.logger.info(
                `${EMOJI.dot} ${pos.symbol} ${side.toUpperCase()} · entry ${entry} → now ${current} · ` +
                `PnL ${pnl.toFixed(2)} (${pnlPct.toFixed(2)}%) · age ${ageHours.toFixed(2)}h`
            );
            let reason = null;
            if (cfg.close_before_reopen) reason = "close-before-reopen";
            else if (cfg.auto_close_on_profit_pct > 0 && pnlPct >= cfg.auto_close_on_profit_pct) reason = `profit +${pnlPct.toFixed(2)}%`;
            else if (cfg.auto_close_on_loss_pct > 0 && pnlPct <= -Math.abs(cfg.auto_close_on_loss_pct)) reason = `loss ${pnlPct.toFixed(2)}%`;
            else if (cfg.auto_close_after_hours > 0 && ageHours >= cfg.auto_close_after_hours) reason = `max-age ${ageHours.toFixed(2)}h`;
            if (!reason) continue;
            this.logger.warn(`${EMOJI.bolt} Closing ${pos.symbol} — ${reason}`);
            const res = await this.closePosition(email, pos, current, agent);
            if (res.ok) {
                const realizedPnl = Number(res.pnl ?? pnl);
                this.logger.ok(`${EMOJI.party} Closed ${pos.symbol} @ ${current} — ${reason} · PnL ${realizedPnl.toFixed(2)}`);
                report.positions_closed = (report.positions_closed || 0) + 1;
                report.realized_pnl = (report.realized_pnl || 0) + realizedPnl;
            } else {
                this.logger.error(`${EMOJI.cross} Close failed: ${res.error}`);
                report.close_errors = (report.close_errors || 0) + 1;
            }
        }
    }

    async getActiveQuiz(email, agent) { return this.apiRpc(email, "get_active_quiz", {}, agent); }
    async submitQuizAnswer(email, key, agent) {
        return this.apiRpc(email, "submit_quiz_answer", { p_answer: key }, agent);
    }

    _logQuizEntry(entry) {
        const file = this.cfg.features.quiz_log_path || FILE_QUIZ_LOG;
        let log = loadJSON(file, []);
        if (!Array.isArray(log)) log = [];
        log.push(entry);
        if (log.length > 500) log = log.slice(-500);
        saveJSONAtomic(file, log);
    }

    async runQuizTask(email, agent, report) {
        if (!this.cfg.features.quiz) return;
        if (!this.cfg.features.quiz_auto_submit) return;
        if (!this.quizSolver.isEnabled()) {
            this.logger.warn(`${EMOJI.warn} Quiz: solver disabled`);
            return;
        }
        let quiz;
        try { quiz = await this.getActiveQuiz(email, agent); }
        catch (e) { this.logger.warn(`${EMOJI.warn} Quiz: ${e.message}`); return; }
        if (!quiz || quiz.__rpc_error) return;
        if (!quiz.active || !quiz.quiz) { this.logger.info(`ℹ Quiz: no active quiz`); return; }
        if (quiz.my_submission) {
            this.logger.info(`${EMOJI.check} Quiz: already submitted today`);
            report.quiz_skipped_reason = "already-submitted";
            return;
        }
        const q = quiz.quiz;
        const reward = q.reward_kdx || 0;
        this.logger.info(`${EMOJI.target} Quiz: "${q.title}" · +${reward} KDX · ${q.joined_count || 0} joined`);

        const letter = await this.quizSolver.solve(q);
        if (!letter) {
            this.logger.error(`${EMOJI.cross} Quiz: solver failed`);
            report.quiz_error = "solver-failed";
            this.webhook.send("quiz_failed", `${email}: solver returned null`);
            return;
        }
        const chosen = (q.options || []).find(o => String(o.key).toLowerCase() === letter);
        this.logger.info(`${EMOJI.bolt} Quiz: AI picked "${letter}" → "${chosen?.label ?? "?"}"`);

        const res = await this.submitQuizAnswer(email, letter, agent);
        const errMsg = String(res?.error || res?.__rpc_error || "").toLowerCase();

        if (res?.success) {
            this.logger.ok(`${EMOJI.party} Quiz submitted: "${letter}" · joined_count=${res.joined_count ?? "?"}`);
            report.quiz_submitted = true;
            report.quiz_answer = letter;
            report.quiz_reward = reward;
            report.tasks_completed = (report.tasks_completed || 0) + 1;
            report.kdx_earned = (report.kdx_earned || 0) + reward;
            this._logQuizEntry({
                ts: new Date().toISOString(), email, quiz_id: q.id,
                question: q.question, answer: letter, label: chosen?.label,
                reward_kdx: reward, result: "submitted"
            });
        } else if (errMsg.includes("already")) {
            this.logger.info(`${EMOJI.check} Quiz: already submitted`);
            report.quiz_skipped_reason = "already-submitted";
        } else {
            this.logger.warn(`${EMOJI.warn} Quiz: submit failed: ${errMsg || "unknown"}`);
            report.quiz_error = errMsg || "unknown";
        }
    }

    async runDailyKdxTask(email, agent, report) {
        if (!this.cfg.features.daily_kdx) return;
        const claimDate = this.cfg.trade?.daily_kdx_use_yesterday === false
            ? todayDate()
            : yesterdayDate();

        const lb = await this.getLeaderboardForDate(email, agent, claimDate);
        if (Array.isArray(lb) && lb[0]) {
            const row = lb[0];
            this.logger.info(
                `${EMOJI.coin} KDX stats (${claimDate}): final=${row.final_kdx_earned ?? 0} · ` +
                `base=${row.base_kdx_earned ?? 0} · tier_bonus=${row.tier_bonus_kdx ?? 0} · ` +
                `tier=${row.tier ?? "?"} · vol_fut=${Number(row.futures_counted_volume || 0).toFixed(2)} · ` +
                `vol_spot=${Number(row.spot_counted_volume || 0).toFixed(2)}`
            );
        }

        const r = await this.claimDailyKdx(email, agent, claimDate);
        const errMsg = String(r?.error || r?.__rpc_error || r?.message || "").toLowerCase();

        if (r?.success) {
            report.kdx_claimed = true;
            report.kdx_claimed_amount = Number(r.kdx_earned || 0);
            this.logger.ok(
                `${EMOJI.coin} KDX claimed (${claimDate}): +${r.kdx_earned ?? 0} KDX ` +
                `(base ${r.base_kdx ?? 0})`
            );
            report.kdx_earned = (report.kdx_earned || 0) + report.kdx_claimed_amount;
        } else if (errMsg.includes("already") || errMsg.includes("claimed")) {
            report.kdx_claimed = true;
            report.kdx_claimed_amount = 0;
            this.logger.ok(`${EMOJI.coin} KDX (${claimDate}): already claimed`);
        } else if (errMsg.includes("no") && errMsg.includes("leaderboard")) {
            this.logger.info(`${EMOJI.coin} KDX (${claimDate}): no leaderboard entry`);
        } else {
            this.logger.warn(`${EMOJI.warn} KDX claim (${claimDate}) failed: ${errMsg || JSON.stringify(r).slice(0, 120)}`);
        }
    }

    proxyAgentFor(email) {
        if (!this.useProxy) return null;
        if (!this.proxy || !this.proxy.proxies.length) return null;
        const u = this.proxy.nextForAccount(email);
        return u ? this.proxy.buildAgent(u) : null;
    }

    async checkConnection(email) {
        if (!this.useProxy) return { ok: true, agent: null };
        const agent = this.proxyAgentFor(email);
        try {
            await axios.get("https://api.ipify.org?format=json",
                { timeout: 15000, httpsAgent: agent || undefined, proxy: false });
            return { ok: true, agent };
        } catch (e) {
            this.logger.error(`${EMOJI.cross} Connection failed: ${e.message}`);
            return { ok: false, agent };
        }
    }

    async _runTrade(email, agent, report) {
        const symbol = this.cfg.trade.symbols[0] || "BTCUSDT";
        await this._closeStalePositions(email, agent, report);

        const open = await this.getMyOpenPositions(email, agent);
        const openOnSymbol = (open || []).filter(p => p.symbol === symbol);
        if (openOnSymbol.length >= this.cfg.trade.max_open_positions) {
            this.logger.warn(`${EMOJI.warn} Trade skipped — max open`);
            report.trade_skipped_reason = "max-open";
            return;
        }
        const pending = await this.getLimitOrders(email, agent);
        if (Array.isArray(pending) && pending.some(o => o.symbol === symbol)) {
            this.logger.warn(`${EMOJI.warn} Trade skipped — pending limit`);
            report.trade_skipped_reason = "pending-limit";
            return;
        }
        const bal = await this.getBalances(email, agent);
        if (!bal) { report.trade_skipped_reason = "no-balances"; return; }

        const usdt = Number(bal.demo_usdt_balance || 0);
        const oilBalance = Number(bal.oil_balance || 0);
        const oilLocked  = Number(bal.oil_locked || 0);
        const oil = Math.max(0, oilBalance - oilLocked);

        if (usdt < this.cfg.risk.min_usdt) { report.trade_skipped_reason = "low-usdt"; return; }
        if (oil < this.cfg.risk.min_oil) { report.trade_skipped_reason = "low-oil"; return; }

        const btc = await this.getPrice(symbol, agent);
        if (!btc) { report.trade_skipped_reason = "no-price"; return; }

        const fixedMargin = Number(this.cfg.trade.fixed_margin || 0);
        let margin;
        if (fixedMargin > 0) {
            margin = fixedMargin;
            this.logger.info(`${EMOJI.dot} Using fixed margin: ${margin}`);
        } else {
            const rawMargin = this.cfg.trade.margin_source === "oil"
                ? oil * (this.cfg.trade.margin_pct / 100)
                : Math.min(usdt, oil) * (this.cfg.trade.margin_pct / 100);
            margin = Math.floor(rawMargin * 100) / 100;
        }
        if (margin < this.cfg.risk.min_usdt) { report.trade_skipped_reason = "low-margin"; return; }

        const oilFeeNeeded = margin * this.cfg.trade.leverage * OIL_FEE_MULTIPLIER;
        if (oilFeeNeeded > oil) {
            const maxMargin = Math.floor((oil / (this.cfg.trade.leverage * OIL_FEE_MULTIPLIER)) * 100) / 100;
            if (maxMargin < this.cfg.risk.min_usdt) {
                report.trade_skipped_reason = "low-oil-for-fee";
                return;
            }
            this.logger.warn(`${EMOJI.warn} Auto-shrink margin: ${margin} → ${maxMargin}`);
            margin = maxMargin;
        }

        const cap = Number(this.cfg.trade.max_margin_per_order || 0);
        if (cap > 0 && margin > cap) {
            this.logger.warn(`${EMOJI.warn} Capping margin ${margin} → ${cap}`);
            margin = cap;
        }

        const tp = +(btc * (1 + this.cfg.trade.tp_pct / 100)).toFixed(2);
        const sl = +(btc * (1 - this.cfg.trade.sl_pct / 100)).toFixed(2);
        const oilFeeFinal = (margin * this.cfg.trade.leverage * OIL_FEE_MULTIPLIER).toFixed(2);

        this.logger.info(`${EMOJI.chart} Trade: ${symbol} Long @ ${btc} · margin ${margin} · fee ${oilFeeFinal} OIL · TP ${tp} · SL ${sl}`);
        const res = await this.executeTradeRpc(email, {
            symbol, side: "long", leverage: this.cfg.trade.leverage,
            margin, entry_price: btc, take_profit: tp, stop_loss: sl,
            margin_mode: this.cfg.trade.margin_mode
        }, agent);

        if (res?.success) {
            report.trade_opened = true;
            this.logger.ok(`${EMOJI.party} Trade opened!`);
        } else {
            const err = res?.error || res?.__rpc_error || JSON.stringify(res);
            this.logger.error(`${EMOJI.cross} Trade failed: ${err}`);
            report.trade_skipped_reason = `trade-failed: ${err}`;
        }
    }

    async processAccount(email, idx, total) {
        const start = Date.now();
        const report = {
            email, ok: true,
            faucet_claimed: false, bonus_claimed: false,
            kdx_claimed: false, kdx_claimed_amount: 0,
            tasks_completed: 0, tasks_skipped: 0,
            trade_opened: false, trade_skipped_reason: "",
            kdx_earned: 0, oil_balance: 0, usdt_balance: 0,
            tier: "", errors: [], duration_sec: 0,
            positions_closed: 0, realized_pnl: 0, close_errors: 0,
            quiz_submitted: false, quiz_answer: null, quiz_reward: 0,
            quiz_skipped_reason: "", quiz_error: null
        };

        const conn = await this.checkConnection(email);
        if (!conn.ok) { report.ok = false; report.errors.push("connection"); return report; }
        const agent = conn.agent;

        if (!await this.ensureFreshToken(email, agent)) {
            report.ok = false; report.errors.push("refresh-failed"); return report;
        }

        let bal = await this.getBalances(email, agent);
        if (bal) {
            report.usdt_balance = Number(bal.demo_usdt_balance || 0);
            report.oil_balance = Number(bal.oil_balance || 0);
            this.logger.info(`${EMOJI.money} USDT: ${report.usdt_balance} · OIL: ${report.oil_balance} · KDX: ${bal.kdx_balance || 0} · ETH: ${bal.eth_balance || 0}`);
        }

        if (this.cfg.features.tier_display) {
            const tier = await this.getTier(email, agent);
            const name = tier?.tiers?.name || "Bronze";
            report.tier = name;
            this.logger.info(`${EMOJI.gem} Tier: ${name}`);
        }

        const streak = await this.getTradingStreak(email, agent);
        if (Array.isArray(streak) && streak[0]) {
            this.logger.info(`${EMOJI.fire} Streak: ${streak[0].current_streak || 0} days`);
        }

        const lb = await this.getLeaderboardToday(email, agent);
        if (Array.isArray(lb) && lb[0]) {
            this.logger.info(`${EMOJI.star} Today: ${lb[0].trade_count || 0} trades · $${Number(lb[0].total_counted_volume || 0).toLocaleString()} vol`);
        }

        if (this.cfg.features.quiz) await this.runQuizTask(email, agent, report);

        if (this.cfg.features.faucet) {
            const r = await this.claimFaucet(email, agent);
            const errMsg = String(r?.error || r?.__rpc_error || "").toLowerCase();
            if (r?.success) {
                report.faucet_claimed = true;
                this.logger.ok(`${EMOJI.gift} Faucet: ${r.amount} ${String(r.currency || "USDT").toUpperCase()}`);
            } else if (errMsg.includes("already")) {
                report.faucet_claimed = true;
                this.logger.ok(`${EMOJI.gift} Faucet: already claimed`);
            } else {
                this.logger.warn(`${EMOJI.warn} Faucet: ${errMsg || JSON.stringify(r).slice(0, 100)}`);
            }
        }

        if (this.cfg.features.oil) {
            const r = await this.claimOil(email, agent);
            const errMsg = String(r?.error || r?.__rpc_error || "").toLowerCase();
            if (r?.success) {
                report.bonus_claimed = true;
                this.logger.ok(`${EMOJI.oil} Oil: ${r.amount} ${String(r.currency || "OIL").toUpperCase()}`);
            } else if (errMsg.includes("already")) {
                report.bonus_claimed = true;
                this.logger.ok(`${EMOJI.oil} Oil: already claimed`);
            } else {
                this.logger.warn(`${EMOJI.warn} Oil: ${errMsg || JSON.stringify(r).slice(0, 100)}`);
            }
        }

        if (this.cfg.features.daily_kdx) await this.runDailyKdxTask(email, agent, report);

        if (this.cfg.features.eth_to_oil && this.cfg.risk.auto_exchange_eth_to_oil) {
            bal = await this.getBalances(email, agent);
            if (bal) {
                const oil = Number(bal.oil_balance || 0);
                const eth = Number(bal.eth_balance || 0);
                if (oil < this.cfg.risk.min_oil_trigger_exchange && eth >= this.cfg.risk.min_eth_to_exchange) {
                    const amt = Math.min(eth * 0.5, eth);
                    this.logger.info(`${EMOJI.refresh} ETH → OIL: ${amt}`);
                    const r = await this.exchangeEthForOil(email, amt, agent);
                    if (r?.success) this.logger.ok(`${EMOJI.oil} Swap OK: +${r.oil_amount || "?"} OIL`);
                }
            }
        }

        if (this.cfg.features.usdt_transfer && this.cfg.risk.auto_transfer_spot_to_futures) {
            bal = await this.getBalances(email, agent);
            if (bal) {
                const spot = Number(bal.spot_usdt_balance || bal.demo_usdt_balance || 0);
                const fut = Number(bal.futures_usdt_balance || 0);
                if (fut < this.cfg.risk.min_futures_usdt && spot >= 20) {
                    const amt = Math.round((spot - 10) * 100) / 100;
                    const r = await this.transferUsdt(email, "spot", "futures", amt, agent);
                    if (r?.success) this.logger.ok(`${EMOJI.check} Spot → Futures: ${amt} USDT`);
                }
            }
        }

        if (this.cfg.features.trade && this.cfg.trade.enabled) {
            await this._runTrade(email, agent, report);
        }

        report.duration_sec = (Date.now() - start) / 1000;
        return report;
    }

    async runTradingCycle(cycleNum, totalCycles) {
        this.logger.summary(`\n${"═".repeat(60)}`);
        this.logger.summary(`  📈 Trading Cycle ${cycleNum} / ${totalCycles}`);
        this.logger.summary(`${"═".repeat(60)}`);

        const accounts = this.loadAccounts();
        if (!accounts.length) { this.logger.error(`${EMOJI.cross} No accounts`); return; }
        this.report.accounts_total = accounts.length;

        const interMin = this.cfg.runtime.inter_account_delay_min || 3;
        const interMax = this.cfg.runtime.inter_account_delay_max || 8;

        for (let i = 0; i < accounts.length; i++) {
            if (this.shutdown) break;
            const acc = accounts[i];
            const email = acc.email;
            if (!email || !acc.access_token || !acc.refresh_token) {
                this.logger.error(`${EMOJI.cross} Invalid account ${i}`);
                continue;
            }
            this.accounts.set(email, {
                access_token: acc.access_token,
                refresh_token: acc.refresh_token,
                user_id: null
            });
            const t = this.decodeToken(email);
            if (!t) {
                this.logger.error(`${EMOJI.cross} Bad token ${maskEmail(email)}`);
                this.report.accounts_failed++;
                continue;
            }
            this.accounts.get(email).user_id = t.userId;

            this.logger.accountStart(i + 1, accounts.length, email);
            try {
                const r = await this.processAccount(email, i + 1, accounts.length);
                this.report.per_account.push(r);
                if (r.ok) {
                    this.report.accounts_ok++;
                    if (r.faucet_claimed) this.report.faucet_claimed++;
                    if (r.bonus_claimed) this.report.bonus_claimed++;
                    if (r.kdx_claimed) this.report.kdx_claims_ok++;
                    if (r.kdx_claimed_amount) this.report.kdx_total_claimed += r.kdx_claimed_amount;
                    this.report.tasks_completed += r.tasks_completed;
                    if (r.trade_opened) this.report.trades_opened++;
                    if (r.positions_closed) this.report.positions_closed += r.positions_closed;
                    if (r.realized_pnl) this.report.realized_pnl += r.realized_pnl;
                    if (r.close_errors) this.report.close_errors += r.close_errors;
                    if (r.quiz_submitted) this.report.quizzes_submitted++;
                    this.report.total_kdx_earned += r.kdx_earned;
                } else {
                    this.report.accounts_failed++;
                }
            } catch (e) {
                this.logger.error(`${EMOJI.cross} Crash: ${e.message}`);
                this.report.accounts_failed++;
            }

            const processed = this.report.accounts_ok + this.report.accounts_failed;
            if (processed >= 5) {
                const failPct = (this.report.accounts_failed / processed) * 100;
                if (failPct >= this.cfg.runtime.circuit_breaker_pct) {
                    this.logger.critical(`${EMOJI.cross} Circuit breaker: ${failPct.toFixed(1)}% failed`);
                    break;
                }
            }

            if (i < accounts.length - 1) await sleep(rand(interMin, interMax) * 1000);
        }
    }

    printSummary() {
        const r = this.report;
        console.log(chalk.cyanBright.bold("\n╔═══════════════════════ SUMMARY ═══════════════════════╗"));
        console.log(`║ ${EMOJI.check}  Accounts OK      ${chalk.whiteBright(r.accounts_ok)} / ${chalk.whiteBright(r.accounts_total)}`);
        console.log(`║ ${EMOJI.cross}  Accounts Failed  ${chalk.whiteBright(r.accounts_failed)}`);
        console.log(`║ ${EMOJI.gift}  Faucet claimed   ${chalk.whiteBright(r.faucet_claimed)}`);
        console.log(`║ ${EMOJI.oil}  Oil claimed      ${chalk.whiteBright(r.bonus_claimed)}`);
        console.log(`║ ${EMOJI.coin}  KDX claimed      ${chalk.whiteBright(r.kdx_claims_ok || 0)} accounts · +${chalk.whiteBright((r.kdx_total_claimed || 0).toFixed(4))}`);
        console.log(`║ ${EMOJI.target} Tasks completed  ${chalk.whiteBright(r.tasks_completed)}`);
        console.log(`║ ${EMOJI.target} Quizzes answered ${chalk.whiteBright(r.quizzes_submitted)}`);
        console.log(`║ ${EMOJI.chart} Trades opened    ${chalk.whiteBright(r.trades_opened)}`);
        console.log(`║ ${EMOJI.check}  Positions closed ${chalk.whiteBright(r.positions_closed)}`);
        console.log(`║ ${EMOJI.money}  Realized PnL     ${chalk.whiteBright((r.realized_pnl || 0).toFixed(2))} USDT`);
        if (r.close_errors) console.log(`║ ${EMOJI.cross}  Close errors     ${chalk.redBright(r.close_errors)}`);
        console.log(`║ ${EMOJI.coin}  KDX earned       ${chalk.whiteBright(r.total_kdx_earned)}`);
        console.log(chalk.cyanBright.bold("╚═══════════════════════════════════════════════════════╝\n"));
    }

    async run() {
        this.logger.banner();

        const dailyTrades = this.cfg.trade.daily_trades || 1;
        const gapMinutes = this.cfg.trade.cycle_gap_minutes || Math.floor(1440 / dailyTrades);
        const gapSec = gapMinutes * 60;

        if (this.useProxy) await this.proxy.preflight();
        else this.logger.info(`${EMOJI.globe} Running WITHOUT proxy`);

        this.logger.summary(`🤖 Groq solver: ${this.quizSolver.isEnabled() ? "enabled" : "disabled"}`);
        this.logger.summary(`📈 Trading: ${dailyTrades} cycles/day · ${gapMinutes}min between cycles`);

        for (let cycle = 1; cycle <= dailyTrades; cycle++) {
            if (this.shutdown) break;
            this.report = this._newReport();
            await this.runTradingCycle(cycle, dailyTrades);
            this.printSummary();

            const stamp = new Date().toISOString().replace(/[:.]/g, "-");
            saveJSONAtomic(path.join(DIR_LOGS, `run_c${cycle}_${stamp}.json`), this.report);

            await this.webhook.send("cycle_summary",
                `Cycle ${cycle}/${dailyTrades} — OK: ${this.report.accounts_ok}/${this.report.accounts_total} · ` +
                `Trades: ${this.report.trades_opened} · Closed: ${this.report.positions_closed} · ` +
                `PnL: ${this.report.realized_pnl.toFixed(2)}`);

            if (cycle < dailyTrades && !this.shutdown) {
                this.logger.summary(`${EMOJI.hourglass} Waiting ${gapMinutes}min until cycle ${cycle + 1}...`);
                let seconds = gapSec;
                while (seconds > 0 && !this.shutdown) {
                    process.stdout.write(chalk.cyanBright(`\r${EMOJI.hourglass}  Next cycle in ${fmtSeconds(seconds)} ...`));
                    await sleep(1000);
                    seconds--;
                }
                console.log();
            }
        }

        this.logger.summary(`${EMOJI.check} All cycles complete. Exiting.`);
    }
}

function ask(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()); }));
}

async function showMenu() {
    console.log(chalk.cyanBright.bold(`
╔═══════════════════════════════════════════════════════╗
║                                                       ║
║           🤖  KieDex Bot v1 — Startup                ║
║                                                       ║
╠═══════════════════════════════════════════════════════╣
║                                                       ║
║   [1]  Run WITHOUT proxy  (direct connection)        ║
║   [2]  Run WITH proxy     (uses proxy.txt)           ║
║   [0]  Exit                                          ║
║                                                       ║
╚═══════════════════════════════════════════════════════╝
`));
    return await ask(chalk.whiteBright("  ➜ Choose option [0-2]: "));
}

async function main() {
    const verbose = argFlag("--verbose");
    const quiet = argFlag("--quiet");

    const config = loadConfig();
    const logger = new Logger(config, verbose, quiet);

    let useProxy = true;

    if (!argFlag("--no-menu")) {
        while (true) {
            const choice = await showMenu();
            if (choice === "1") { useProxy = false; break; }
            if (choice === "2") { useProxy = true;  break; }
            if (choice === "0") { console.log(chalk.gray("\n  Bye.\n")); process.exit(0); }
            console.log(chalk.redBright("\n  ✗ Invalid choice. Try again.\n"));
        }
    } else {
        useProxy = !argFlag("--no-proxy");
    }

    const webhook = new Webhook(config, logger);
    const proxy = new ProxyManager(config, logger);

    process.on("uncaughtException", async (e) => {
        logger.critical(`Uncaught: ${e.message}`);
        await webhook.send("crash", `Uncaught: ${e.message}`);
        process.exit(1);
    });
    process.on("unhandledRejection", (e) => {
        logger.error(`Unhandled: ${e?.message || e}`);
    });

    const bot = new KieDexBot(config, logger, webhook, proxy, { verbose, useProxy });

    if (config.features?.quiz && bot.quizSolver.isEnabled()) {
        try {
            const test = await bot.quizSolver._callGroq(config.ai.model, "Answer with the single letter: a", 8000);
            logger.ok(`🤖 Groq reachable — responded "${String(test).trim().slice(0, 10)}"`);
        } catch (e) {
            logger.warn(`⚠️ Groq unreachable: ${e.message}`);
        }
    }

    logger.info(`Mode: LIVE · Proxy: ${useProxy ? "ON" : "OFF"}`);

    try { await bot.run(); }
    catch (e) {
        logger.critical(`Fatal: ${e.message}`);
        await webhook.send("crash", `Fatal: ${e.message}`);
    } finally { logger.close(); }
}

main().catch(e => { console.error("BOOT FAIL:", e); process.exit(1); });