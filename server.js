/*
 * Simple HTTP server for the TeleSwapX demo application.
 *
 * This server uses only built‑in Node modules so that it can run in
 * environments without access to npm modules. It serves a small
 * single‑page application from the `public` directory and exposes a
 * handful of JSON API endpoints for swapping and perpetual trading.
 *
 * The API endpoints are intentionally simplistic – they do not
 * perform real blockchain interactions, but instead return mock
 * responses so that the front‑end can demonstrate the workflow and
 * update the UI accordingly. The in‑memory state of open positions
 * lives in the `positions` array defined below.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

// -----------------------------------------------------------------------------
// Rango API integration
//
// To support cross‑chain swaps from any blockchain to TON, this server can
// optionally proxy requests through the Rango Exchange API. Rango is a
// bridge/DEX aggregator that finds the best route between two assets across
// many chains and bridges. If an API key is provided via the environment
// variable `RANGO_API_KEY`, the `/api/quote` and `/api/swap` endpoints will
// call out to Rango to retrieve real quotes and transaction data. Without
// an API key, these endpoints gracefully fall back to mocked responses.

// Read the Rango API key from the environment. If not provided, the server
// will skip real API calls and use mock responses instead.
const RANGO_API_KEY = process.env.RANGO_API_KEY || '';

// Commission rate applied when swapping into TON. Represents a 0.3% fee by
// default. Clients subtract this amount from the estimated output. It can
// be overridden with the SWAP_FEE_RATE_TON environment variable.
const SWAP_FEE_RATE_TON = process.env.SWAP_FEE_RATE_TON ? parseFloat(process.env.SWAP_FEE_RATE_TON) : 0.003;

// -----------------------------------------------------------------------------
// Prediction asset configuration
//
// The set of assets available for binary prediction markets. By default
// predictions are allowed on GIFTS, STICKERS and TON. You can override
// this list via the ALLOWED_PREDICTION_ASSETS environment variable (comma
// separated). TON predictions use a constant cap based on the total
// circulating supply of Toncoin (see TON_SUPPLY_TON below).
const ALLOWED_PREDICTION_ASSETS = (process.env.ALLOWED_PREDICTION_ASSETS || 'GIFTS,STICKERS,TON')
  .split(',')
  .map(s => s.trim().toUpperCase())
  .filter(Boolean);

// Estimated total supply of Toncoin expressed in TON. Since the market cap
// of TON in TON units is effectively equal to its total supply (price
// cancels out), predictions on TON will have a constant cap. You can
// override this value via the TON_SUPPLY_TON environment variable.
const TON_SUPPLY_TON = process.env.TON_SUPPLY_TON ? parseFloat(process.env.TON_SUPPLY_TON) : 5000000000;

// -----------------------------------------------------------------------------
// TON price oracle configuration
//
// To dynamically fetch the current Toncoin price in USD, the server can call an
// external API. By default, CoinGecko's simple price endpoint is used. You can
// override the URL and provide an API key via environment variables
// TON_PRICE_API_URL and TON_PRICE_API_KEY, respectively. If the fetch fails
// or the response is invalid, the price oracle will return null. The client
// should handle null values appropriately (e.g. by falling back to a default
// or disabling TON price‑based predictions).

const TON_PRICE_API_URL = process.env.TON_PRICE_API_URL ||
  'https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd';
const TON_PRICE_API_KEY = process.env.TON_PRICE_API_KEY || '';

/**
 * Fetch the latest Toncoin price in USD.
 *
 * This function queries the configured API endpoint and attempts to extract
 * the USD price of Toncoin. If the call fails or returns unexpected
 * structure, the function resolves to null. The caller can decide how to
 * handle null (for example, by falling back to a static value or skipping
 * TON price‑based logic).
 *
 * @returns {Promise<number|null>} The TON price in USD, or null on error.
 */
async function fetchTonPriceUsd() {
  try {
    let url = TON_PRICE_API_URL;
    if (TON_PRICE_API_KEY) {
      const sep = url.includes('?') ? '&' : '?';
      url = `${url}${sep}apikey=${encodeURIComponent(TON_PRICE_API_KEY)}`;
    }
    const data = await fetchJsonFromUrl(url);
    let price = null;
    if (data) {
      // CoinGecko returns an object keyed by token ID. Try multiple keys for
      // compatibility with other APIs.
      if (data['the-open-network'] && data['the-open-network'].usd) {
        price = parseFloat(data['the-open-network'].usd);
      } else if (data['toncoin'] && data['toncoin'].usd) {
        price = parseFloat(data['toncoin'].usd);
      } else if (typeof data === 'number') {
        price = parseFloat(data);
      }
    }
    return isFinite(price) ? price : null;
  } catch (err) {
    return null;
  }
}

// -----------------------------------------------------------------------------
// Withdrawal fee and limit configuration
//
// The platform charges a fee on user withdrawals and enforces daily and
// monthly limits to manage liquidity. These values can be overridden via
// environment variables:
//  - WITHDRAW_FEE_RATE: commission rate applied to withdrawals (default 5%)
//  - WITHDRAW_LIMIT_DAILY: maximum total TON a user can withdraw in a day
//    (default 500 TON)
//  - WITHDRAW_LIMIT_MONTHLY: maximum total TON a user can withdraw in a month
//    (default 3000 TON)
const WITHDRAW_FEE_RATE = process.env.WITHDRAW_FEE_RATE ? parseFloat(process.env.WITHDRAW_FEE_RATE) : 0.05;
const WITHDRAW_LIMIT_DAILY = process.env.WITHDRAW_LIMIT_DAILY ? parseFloat(process.env.WITHDRAW_LIMIT_DAILY) : 500;
const WITHDRAW_LIMIT_MONTHLY = process.env.WITHDRAW_LIMIT_MONTHLY ? parseFloat(process.env.WITHDRAW_LIMIT_MONTHLY) : 3000;

// Keep track of user withdrawal history. Each entry is { ts: milliseconds since epoch,
// amountTon: number } so that we can compute daily and monthly usage. This
// map is keyed by userId and stores an array of withdrawal entries.
const withdrawalLog = new Map();

// Queue of pending withdrawals awaiting administrator review. Each entry
// has the form { id, userId, amountTon, feeTon, netTon, to, status,
// requestedAt }. When a user initiates a withdrawal, the request is
// pushed onto this queue with status 'pending'. An admin can later
// process the request via the admin API, changing the status to
// 'completed'.
const withdrawQueue = [];

// Secret token used to authenticate admin endpoints. Set the
// environment variable ADMIN_SECRET to a strong random string. If this
// value is empty, admin endpoints are effectively disabled. Clients
// must provide this secret via the X-Admin-Secret header or the
// `secret` query parameter.
// ADMIN_SECRET is defined earlier in the file. Do not redeclare it here.

/**
 * Calculate the withdrawal usage for a given user over the last day and last
 * month. The function sums all withdrawals recorded in withdrawalLog that
 * occurred within the respective time windows. If there is no history, it
 * returns zero for both. This helper is shared by withdrawal limit
 * enforcement and API responses.
 *
 * @param {string} userId The user identifier
 * @returns {{dailyUsed: number, monthlyUsed: number}}
 */
function getWithdrawUsage(userId) {
  const uid = String(userId);
  const logs = withdrawalLog.get(uid) || [];
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const monthMs = 30 * dayMs;
  let dailyUsed = 0;
  let monthlyUsed = 0;
  for (const entry of logs) {
    const diff = now - entry.ts;
    if (diff < monthMs) {
      monthlyUsed += entry.amountTon;
      if (diff < dayMs) {
        dailyUsed += entry.amountTon;
      }
    }
  }
  return { dailyUsed, monthlyUsed };
}

/**
 * Request a quote from Rango for swapping a given amount of one asset to
 * another. The amount must be specified in the smallest unit of the
 * source token (e.g. wei for ETH, satoshi for BTC). The API will return
 * detailed route information including the estimated output amount and
 * token metadata. Slippage is expressed as a percentage (e.g. 1.0 for 1%).
 *
 * @param {string} from The source asset in the form `CHAIN.SYMBOL` or
 *                      `CHAIN--ADDRESS`
 * @param {string} to   The destination asset in the same notation
 * @param {string|number} amount Amount in the smallest unit of the source token
 * @param {number|string} slippage Percentage of acceptable slippage (default 1.0)
 * @returns {Promise<object>} The parsed JSON response from Rango
 */
function getRangoQuote(from, to, amount, slippage = 1.0) {
  return new Promise((resolve, reject) => {
    if (!RANGO_API_KEY) {
      reject(new Error('RANGO_API_KEY not configured'));
      return;
    }
    const apiUrl = `https://api.rango.exchange/basic/quote?from=${encodeURIComponent(
      from
    )}&to=${encodeURIComponent(to)}&amount=${encodeURIComponent(
      amount
    )}&slippage=${encodeURIComponent(slippage)}&apiKey=${RANGO_API_KEY}`;
    fetchJsonFromUrl(apiUrl)
      .then(data => resolve(data))
      .catch(err => reject(err));
  });
}

/**
 * Create a swap transaction via Rango. This call returns a transaction
 * description that can be used by the client to execute the swap onchain.
 * Addresses must be provided for both sides of the swap; if not supplied
 * the transaction will not be attempted. This helper is optional – the
 * application can perform the final signing and sending client side once
 * the quote has been reviewed.
 *
 * @param {string} from The source asset (`CHAIN.SYMBOL` or `CHAIN--ADDRESS`)
 * @param {string} to   The destination asset
 * @param {string|number} amount The amount in smallest units of the source token
 * @param {string} fromAddress The wallet address on the source chain
 * @param {string} toAddress   The wallet address on the destination chain
 * @param {number|string} slippage Slippage percentage (default 3.0)
 * @returns {Promise<object>} The parsed JSON response from Rango
 */
function createRangoSwap(from, to, amount, fromAddress, toAddress, slippage = 3.0) {
  return new Promise((resolve, reject) => {
    if (!RANGO_API_KEY) {
      reject(new Error('RANGO_API_KEY not configured'));
      return;
    }
    const params = new URLSearchParams({
      from,
      to,
      amount: String(amount),
      slippage: String(slippage),
      fromAddress: fromAddress || '',
      toAddress: toAddress || '',
      disableEstimate: 'true',
      apiKey: RANGO_API_KEY,
    });
    const url = `https://api.rango.exchange/basic/swap?${params.toString()}`;
    fetchJsonFromUrl(url)
      .then(data => resolve(data))
      .catch(err => reject(err));
  });
}

// In‑memory store of open perpetual positions (no longer used; kept for compatibility)
const positions = [];

// -----------------------------------------------------------------------------
// Persistent storage via PostgreSQL
//
// The application can optionally store user balances in a PostgreSQL table
// instead of the in‑memory ledger. To enable this, provide a connection
// string via the PG_CONNECTION_STRING environment variable. When set, the
// server will attempt to connect using the `pg` module and use the table
// `balances` with schema:
//   CREATE TABLE IF NOT EXISTS balances (
//     user_id TEXT PRIMARY KEY,
//     balance NUMERIC
//   );
// If the module or connection is unavailable, the server falls back to the
// in‑memory ledger. Persistent storage functions are exposed via
// getPersistentBalance() and updatePersistentBalance().

let pgPool = null;
const PG_CONNECTION_STRING = process.env.PG_CONNECTION_STRING || '';
try {
  if (PG_CONNECTION_STRING) {
    const { Pool } = require('pg');
    pgPool = new Pool({ connectionString: PG_CONNECTION_STRING });
    // Ensure the balances table exists
    pgPool.query(
      'CREATE TABLE IF NOT EXISTS balances (user_id TEXT PRIMARY KEY, balance NUMERIC)',
    ).catch(() => {
      // If the table creation fails, fallback to in‑memory
      pgPool = null;
    });
  }
} catch (err) {
  // pg module not available; ignore and use in‑memory storage
  pgPool = null;
}

/**
 * Fetch the persistent balance for a user from PostgreSQL. If the pool
 * is not configured, this falls back to the in‑memory ledger. Returns
 * a promise that resolves to the balance in TON as a number.
 *
 * @param {string} userId
 * @returns {Promise<number>}
 */
async function getPersistentBalance(userId) {
  const uid = String(userId);
  if (!pgPool) {
    // fallback to in‑memory
    return getBal(uid);
  }
  try {
    const res = await pgPool.query('SELECT balance FROM balances WHERE user_id = $1', [uid]);
    if (res.rows.length === 0) return 0;
    const val = parseFloat(res.rows[0].balance);
    return isFinite(val) ? val : 0;
  } catch (err) {
    return getBal(uid);
  }
}

/**
 * Update the persistent balance for a user in PostgreSQL. If the pool
 * is not configured, updates only the in‑memory ledger. Returns a
 * promise.
 *
 * @param {string} userId
 * @param {number} balanceTon
 */
async function updatePersistentBalance(userId, balanceTon) {
  const uid = String(userId);
  // Always update in‑memory ledger
  ledger.set(uid, { balanceTon });
  if (!pgPool) return;
  try {
    await pgPool.query(
      'INSERT INTO balances (user_id, balance) VALUES ($1, $2)\n      ON CONFLICT (user_id) DO UPDATE SET balance = EXCLUDED.balance',
      [uid, balanceTon]
    );
  } catch (err) {
    // ignore; fallback state already updated
  }
}

// ----------------------------------------------------------------------------
// Prediction markets for GIFTS and STICKERS
//
// This section implements a simple prediction market where users can take
// positions on whether the market capitalisation of a given asset will be
// above or below its current value at a specified expiry time. All stakes
// are denominated in TON. Predictions are stored in memory and are not
// persisted across server restarts. Real market capitalisation is fetched
// from external APIs (TonAPI and STON.fi) when available; if fetching
// fails, a fallback value of 0 TON is used. You can customise the
// addresses of the GIFTS and STICKERS jettons via environment variables
// `GIFT_ADDR` and `STICKER_ADDR`.

/*
 * ----------------------------------------------------------------------------
 * Prediction market and ledger infrastructure
 *
 * To support more realistic binary markets ("above" vs "below") on the
 * capitalisation of GIFTS or STICKERS, this server maintains a ledger of
 * user balances and a collection of markets. Each market consists of a
 * predicted asset, an expiry timestamp, a strike price (entry capitalisation)
 * and pools of TON stakes on both sides. Bets are associated with a
 * userId so that winnings can be credited back to the correct account.
 *
 *  - ledger: a Map mapping userId → { balanceTon }
 *  - markets: an array of markets. A market has the shape:
 *      {
 *        id: number,
 *        asset: 'GIFTS' | 'STICKERS',
 *        expiry: number (milliseconds since epoch),
 *        strike: number (entry cap in TON),
 *        entryCap: number (alias of strike),
 *        pools: { above: number, below: number },
 *        bets: Array<{ id, userId, direction, stakeTon }>,
 *        status: 'open' | 'settled',
 *        settleCap?: number,
 *        feeCollected?: number
 *      }
 *
 * The helper functions below manage the ledger, market creation and
 * settlement. See the API endpoints near the bottom of this file for
 * how they are exposed to the client.
 */

// Ledger: track internal balances for each user (by userId)
const ledger = new Map();

// ---------------------------------------------------------------------------
// Withdrawal queue and admin interfaces
//
// When a user requests a withdrawal, instead of immediately sending TON onchain,
// the request is added to this queue. An administrator can view pending
// withdrawals via the `/api/admin/withdrawals` endpoint and mark them as
// processed via `/api/admin/withdrawals/process`. This allows manual
// verification, compliance checks, and batching of onchain transfers.

// Each entry in withdrawQueue has the shape:
// { id: string, userId: string, to: string, amountTon: number, feeTon: number,
//   netTon: number, status: 'pending'|'completed', requestedAt: number }
// The withdrawQueue is declared once earlier in the file. Do not redeclare it here.

// Secret for admin endpoints. Must be provided via the ADMIN_SECRET
// environment variable. If not set, admin endpoints will refuse requests.
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';

function getBal(userId) {
  const rec = ledger.get(String(userId));
  return rec && typeof rec.balanceTon === 'number' ? rec.balanceTon : 0;
}

function credit(userId, ton) {
  const uid = String(userId);
  const current = getBal(uid);
  const newBalance = current + (Number(ton) || 0);
  ledger.set(uid, { balanceTon: newBalance });
  // Persist asynchronously if a PG pool is configured
  if (pgPool) {
    updatePersistentBalance(uid, newBalance).catch(() => {});
  }
}

function debit(userId, ton) {
  const uid = String(userId);
  const amount = Number(ton) || 0;
  if (amount <= 0) throw new Error('Invalid debit amount');
  const current = getBal(uid);
  if (current < amount) throw new Error('Insufficient balance');
  const newBalance = current - amount;
  ledger.set(uid, { balanceTon: newBalance });
  // Persist asynchronously if a PG pool is configured
  if (pgPool) {
    updatePersistentBalance(uid, newBalance).catch(() => {});
  }
}

// Prediction markets array
const markets = [];
let nextMarketId = 1;
let nextBetId = 1;

/**
 * Compute a time‑weighted average capitalisation (TWAP) for the given asset
 * over the last `windowMinutes` minutes. In this simplified demo, we reuse
 * computeMarketCap() to fetch a single snapshot. In a real implementation,
 * this function should sample the cap at regular intervals throughout the
 * window and return their average. If the external APIs fail, the function
 * resolves with 0.
 *
 * @param {string} asset The asset symbol ('GIFTS' or 'STICKERS')
 * @param {number} windowMinutes The averaging window in minutes
 * @returns {Promise<number>} The averaged cap in TON
 */
async function computeTwapCap(asset, windowMinutes = 15) {
  try {
    const { capTon } = await computeMarketCap(asset);
    if (capTon && isFinite(capTon)) return capTon;
  } catch (err) {
    // ignore
  }
  return 0;
}

/**
 * Locate an existing open market for the given asset and expiry. If none
 * exists, create a new one. The entryCap (strike) is computed at the time
 * of creation using computeTwapCap().
 *
 * @param {string} asset Asset symbol ('GIFTS' or 'STICKERS')
 * @param {number} expiryMinutes Number of minutes until expiry
 * @param {string} userId Optional userId for computing entry cap (not used)
 * @returns {Promise<object>} The market object
 */
async function getOrCreateMarket(asset, expiryMinutes) {
  const now = Date.now();
  const expiry = now + (Number(expiryMinutes) || 0) * 60 * 1000;
  // Find existing open market with the same asset and expiry timestamp
  const existing = markets.find(m => m.asset === asset && m.expiry === expiry && m.status === 'open');
  if (existing) return existing;
  // No existing market: compute entry cap
  const entryCap = await computeTwapCap(asset);
  const market = {
    id: nextMarketId++,
    asset,
    expiry,
    strike: entryCap,
    entryCap,
    pools: { above: 0, below: 0 },
    bets: [],
    status: 'open',
    openedAt: now,
  };
  markets.push(market);
  return market;
}

/**
 * Settle a market by computing the final capitalisation and distributing
 * winnings back to bettors. A 2% fee is deducted from the total stakes
 * before payouts. In case of a draw (settleCap very close to strike),
 * all stakes are returned. Settled markets are marked as such and include
 * settleCap and feeCollected properties.
 *
 * @param {object} market The market to settle
 * @returns {Promise<object>} The updated market
 */
async function settleMarket(market) {
  if (!market || market.status !== 'open') return market;
  // Compute final cap using TWAP
  const settleCap = await computeTwapCap(market.asset);
  // Determine winner or draw
  const strike = market.strike;
  const eps = 0.002; // 0.2% tie tolerance
  let winner;
  if (strike === 0) {
    winner = 'draw';
  } else if (Math.abs(settleCap - strike) / strike < eps) {
    winner = 'draw';
  } else {
    winner = settleCap > strike ? 'above' : 'below';
  }
  const A = market.pools.above;
  const B = market.pools.below;
  const total = A + B;
  const feeRate = 0.02;
  const fee = total * feeRate;
  const distributable = total - fee;
  if (winner === 'draw') {
    // return all stakes
    for (const b of market.bets) {
      credit(b.userId, b.stakeTon);
    }
  } else {
    const winPool = winner === 'above' ? A : B;
    const perTon = winPool > 0 ? distributable / winPool : 0;
    for (const b of market.bets) {
      if (b.direction === winner) {
        credit(b.userId, b.stakeTon * perTon);
      }
    }
  }
  market.status = 'settled';
  market.settleCap = settleCap;
  market.feeCollected = fee;
  return market;
}

// Default jetton addresses for GIFTS and STICKERS. These can be overridden
// by setting GIFT_ADDR and STICKER_ADDR in the environment. The GIFTS
// address corresponds to the "Premium Gifts" jetton on TON. There is no
// official STICKERS jetton at the time of writing; this placeholder may
// point to a community token or remain empty until one exists.
const DEFAULT_GIFT_ADDR = 'EQBPLWvfNX7ppSHmL14s0j1aPH-pRF_UesijEd5NhseJE-cY';
const DEFAULT_STICKER_ADDR = process.env.STICKER_ADDR || '';

/**
 * Compute the market capitalisation of a given asset in TON. This helper
 * fetches the jetton metadata from tonapi.io to determine total supply and
 * decimals, then queries ston.fi for the USD price of both the asset and
 * TON. The market cap in USD is supply × price; dividing by the TON price
 * yields the market cap expressed in TON. If any step fails, the
 * function resolves with { capTon: 0 }.
 *
 * @param {string} asset Either 'GIFTS' or 'STICKERS'
 * @returns {Promise<{capTon: number}>}
 */
async function computeMarketCap(asset) {
  // Handle Toncoin (TON) separately. The market cap of TON in TON units
  // approximates its circulating supply, since converting from USD to TON
  // cancels out the price term. To support dynamic pricing, we still fetch
  // the current TON price (for potential future use or analytics), but
  // ultimately return the supply constant as the cap. If the price API
  // fails, the fetch helper returns null and is ignored.
  if (asset === 'TON') {
    // For TON predictions we use the current TON price in USD as the index.
    // Fetch the price via the configured oracle. If the call fails or
    // returns null/NaN, fall back to a static default value so that
    // predictions can still settle (albeit with less accuracy). If no
    // default is provided, return 0 which results in a tie.
    let priceUsd = null;
    try {
      priceUsd = await fetchTonPriceUsd();
    } catch (err) {
      priceUsd = null;
    }
    // Use fallback from environment or zero if invalid
    const fallbackPrice = process.env.TON_PRICE_USD_DEFAULT
      ? parseFloat(process.env.TON_PRICE_USD_DEFAULT)
      : null;
    if (!priceUsd || !isFinite(priceUsd)) {
      priceUsd = isFinite(fallbackPrice) ? fallbackPrice : 0;
    }
    // Use the price itself as the index. The prediction market logic only
    // needs a numeric value to compare at entry and expiry. We return the
    // USD price directly as `capTon` (despite the name) because TON
    // predictions are now based on price movements rather than market
    // capitalisation. The units do not matter as long as both strike and
    // settle values use the same base.
    const capTon = priceUsd;
    return { capTon };
  }

  // Determine which jetton address to use for GIFTS or STICKERS
  let address;
  if (asset === 'GIFTS') {
    address = process.env.GIFT_ADDR || DEFAULT_GIFT_ADDR;
  } else if (asset === 'STICKERS') {
    address = process.env.STICKER_ADDR || DEFAULT_STICKER_ADDR;
  } else {
    return { capTon: 0 };
  }
  // For GIFTS and STICKERS, an address must be provided. For TON we use a
  // separate branch. If no address is defined for GIFTS/STICKERS, return 0.
  if (!address) {
    return { capTon: 0 };
  }
  try {
    // Fetch jetton metadata (supply, decimals) from tonapi for GIFTS/STICKERS
    const jettonUrl = `https://tonapi.io/v2/jettons/${address}`;
    const jetton = await fetchJsonFromUrl(jettonUrl);
    const supplyStr = jetton && jetton.total_supply;
    const decimalsStr = jetton && jetton.metadata && jetton.metadata.decimals;
    if (!supplyStr || !decimalsStr) {
      return { capTon: 0 };
    }
    const decimals = parseInt(decimalsStr, 10) || 0;
    const supply = parseFloat(supplyStr) / Math.pow(10, decimals);
    // Fetch price data from ston.fi for the token and TON
    let tokenData = null;
    let tonData = null;
    try {
      tokenData = await fetchJsonFromUrl(`https://api.ston.fi/v1/assets/${address}`);
    } catch (err) {
      tokenData = null;
    }
    try {
      // The canonical TON asset address on ston.fi
      tonData = await fetchJsonFromUrl('https://api.ston.fi/v1/assets/EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c');
    } catch (err) {
      tonData = null;
    }
    const tokenPriceUsd = tokenData && tokenData.dex_price_usd ? parseFloat(tokenData.dex_price_usd) : null;
    const tonPriceUsd = tonData && tonData.dex_price_usd ? parseFloat(tonData.dex_price_usd) : null;
    if (!tokenPriceUsd || !tonPriceUsd || !isFinite(tokenPriceUsd) || !isFinite(tonPriceUsd)) {
      return { capTon: 0 };
    }
    const capUsd = supply * tokenPriceUsd;
    const capTon = capUsd / tonPriceUsd;
    return { capTon };
  } catch (err) {
    // If any API call fails or parsing error occurs, return zero
    return { capTon: 0 };
  }
}


// Telegram bot configuration
// The bot token and the URL of the hosted WebApp should be provided via
// environment variables. BOT_TOKEN is required for sending messages.
// WEBAPP_URL is optional – if not provided, it defaults to an empty string.
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const WEBAPP_URL = process.env.WEBAPP_URL || '';

// Main wallet address used by the platform for deposits and withdrawals.
// Users should send TON to this address to deposit funds, and all outgoing
// transfers will originate from this address. It can be overridden via
// the MAIN_WALLET_ADDRESS environment variable. If not provided, a
// default address is used (should be replaced in production).
const MAIN_WALLET_ADDRESS = process.env.MAIN_WALLET_ADDRESS ||
  'UQDSvn65kPkE4XP40QE9icGdllYbyOA2EtJr08yiaqWB5O9-';

/**
 * Send a request to the Telegram Bot API. This helper constructs an HTTPS
 * POST request using the provided method and JSON payload. It returns a
 * promise that resolves with the parsed JSON response or rejects if an
 * error occurs. If the bot token is not configured, the promise
 * immediately rejects.
 *
 * @param {string} method The Telegram Bot API method (e.g. 'sendMessage')
 * @param {object} payload The JSON payload to send
 */
function sendTelegram(method, payload) {
  return new Promise((resolve, reject) => {
    if (!BOT_TOKEN) {
      reject(new Error('BOT_TOKEN not configured'));
      return;
    }
    const data = JSON.stringify(payload);
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/${method}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    };
    const req = https.request(options, res => {
      let body = '';
      res.on('data', chunk => {
        body += chunk.toString();
      });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          resolve(parsed);
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', err => reject(err));
    req.write(data);
    req.end();
  });
}

// Helper function to send JSON responses
function sendJson(res, status, data) {
  const json = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  });
  res.end(json);
}

/*
 * Fetch a JSON payload from an external HTTPS endpoint.
 * This helper uses the built‑in https module and returns a promise that
 * resolves with the parsed JSON. It will reject if the request fails or
 * if the response cannot be parsed as JSON. Note that in restricted
 * environments this function may not succeed; however, when running on
 * platforms with outbound network access (e.g. Replit) it enables
 * integration with public APIs such as Binance for live price data.
 */
function fetchJsonFromUrl(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, resp => {
        let data = '';
        resp.on('data', chunk => {
          data += chunk;
        });
        resp.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed);
          } catch (err) {
            reject(err);
          }
        });
      })
      .on('error', err => {
        reject(err);
      });
  });
}

// Parse the body of a POST request and invoke a callback with the parsed JSON
function parseBody(req, callback) {
  let body = '';
  req.on('data', chunk => {
    body += chunk.toString();
    // protect against large bodies
    if (body.length > 1e6) req.connection.destroy();
  });
  req.on('end', () => {
    try {
      const data = JSON.parse(body || '{}');
      callback(data);
    } catch (err) {
      callback({});
    }
  });
}

/**
 * Handle API endpoints. Returns true if the request matches an API
 * endpoint and has been handled. Otherwise returns false so the
 * caller can continue to the static file handler.
 */
function handleApi(req, res) {
  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  const pathname = urlObj.pathname;

  // Handle preflight CORS requests
  if (req.method === 'OPTIONS' && pathname.startsWith('/api/')) {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    });
    res.end();
    return true;
  }

  // Swap endpoint – simply echoes back the request
  // Rango quote endpoint: returns an estimated output amount for a given
  // cross‑chain swap. Requires from, to and amount query parameters. When
  // RANGO_API_KEY is not configured, this endpoint returns an error.
  if (pathname === '/api/quote' && req.method === 'GET') {
    const from = urlObj.searchParams.get('from');
    const to = urlObj.searchParams.get('to');
    const amount = urlObj.searchParams.get('amount');
    const slippage = urlObj.searchParams.get('slippage') || '1.0';
    if (!from || !to || !amount) {
      sendJson(res, 400, { error: 'Missing from, to or amount parameter' });
      return true;
    }
    getRangoQuote(from, to, amount, slippage)
      .then(data => {
        let gross = null;
        if (data && data.route && data.route.outputAmount) {
          const output = data.route.outputAmount;
          const decimals = data.route.to && typeof data.route.to.decimals === 'number' ? data.route.to.decimals : 0;
          if (output && !isNaN(output)) {
            const divisor = Math.pow(10, decimals);
            gross = parseFloat(output) / divisor;
          }
        }
        // Apply fee if swapping into TON
        const toUpper = (to || '').toUpperCase();
        let net = gross;
        let feeApplied = false;
        if (gross !== null && toUpper === 'TON' && SWAP_FEE_RATE_TON > 0) {
          net = gross * (1 - SWAP_FEE_RATE_TON);
          feeApplied = true;
        }
        sendJson(res, 200, {
          estimated: net,
          gross,
          feeRate: feeApplied ? SWAP_FEE_RATE_TON : 0,
          raw: data,
        });
      })
      .catch(err => {
        sendJson(res, 500, { error: err.message });
      });
    return true;
  }

  // Swap endpoint – returns a live quote via Rango if configured, otherwise
  // falls back to a mock response. The request body should contain `from`,
  // `to` and `amount` in smallest units. Optional fields: `slippage`,
  // `fromAddress`, `toAddress`. When RANGO_API_KEY is set, the server will
  // fetch a quote and prepare a transaction. Without the key, the server
  // returns a mock success message.
  if (pathname === '/api/swap' && req.method === 'POST') {
    parseBody(req, async ({ from, to, amount, slippage, fromAddress, toAddress }) => {
      // When an API key is available, attempt to get a real quote from Rango
      if (RANGO_API_KEY) {
        try {
          const quoteData = await getRangoQuote(from, to, amount, slippage || 1.0);
          let gross = null;
          if (quoteData && quoteData.route && quoteData.route.outputAmount) {
            const decimals = quoteData.route.to && typeof quoteData.route.to.decimals === 'number' ? quoteData.route.to.decimals : 0;
            gross = parseFloat(quoteData.route.outputAmount) / Math.pow(10, decimals);
          }
          // Apply fee if destination is TON
          const toUpper = (to || '').toUpperCase();
          let net = gross;
          let feeApplied = false;
          if (gross !== null && toUpper === 'TON' && SWAP_FEE_RATE_TON > 0) {
            net = gross * (1 - SWAP_FEE_RATE_TON);
            feeApplied = true;
          }
          // Optionally prepare a transaction if addresses are provided
          let transaction = null;
          if (fromAddress && toAddress) {
            try {
              transaction = await createRangoSwap(from, to, amount, fromAddress, toAddress, slippage || 3.0);
            } catch (txErr) {
              // log but do not fail the request if transaction creation fails
              console.warn('Failed to create Rango transaction', txErr);
            }
          }
          sendJson(res, 200, {
            success: true,
            message: 'Swap prepared',
            estimated: net,
            gross,
            feeRate: feeApplied ? SWAP_FEE_RATE_TON : 0,
            transaction,
          });
        } catch (err) {
          sendJson(res, 500, { success: false, message: err.message });
        }
        return;
      }
      // Fallback mock behaviour when no API key is configured
      const message = `Swapped ${amount || '?'} ${from || '?'} → ${to || '?'} (mock)`;
      // Apply fee if destination is TON. Note: we cannot compute estimated here, so
      // we simply include the fee rate in the response. The front‑end will
      // apply the fee to its own fallback estimate.
      const toUpper = (to || '').toUpperCase();
      const feeRate = toUpper === 'TON' && SWAP_FEE_RATE_TON > 0 ? SWAP_FEE_RATE_TON : 0;
      sendJson(res, 200, {
        success: true,
        message,
        feeRate,
        txHash: `0xmock${Date.now().toString(16)}`,
      });
    });
    return true;
  }

  // Open a new perpetual position
  if (pathname === '/api/perp/open' && req.method === 'POST') {
    parseBody(req, ({ asset, side, leverage, amount }) => {
      const id = positions.length > 0 ? positions[positions.length - 1].id + 1 : 1;
      const position = {
        id,
        asset: asset || 'TON',
        side: side || 'long',
        leverage: Number(leverage) || 1,
        amount: Number(amount) || 0,
        pnl: 0,
        openedAt: Date.now(),
      };
      positions.push(position);
      sendJson(res, 200, { success: true, id });
    });
    return true;
  }

  // List all open positions
  if (pathname === '/api/perp' && req.method === 'GET') {
    sendJson(res, 200, positions);
    return true;
  }

  // Close a position by id
  if (pathname === '/api/perp/close' && req.method === 'POST') {
    parseBody(req, ({ id }) => {
      const index = positions.findIndex(p => p.id === Number(id));
      if (index !== -1) {
        positions.splice(index, 1);
        sendJson(res, 200, { success: true, message: `Position ${id} closed.` });
      } else {
        sendJson(res, 404, { success: false, message: 'Position not found.' });
      }
    });
    return true;
  }

  // Live price endpoint: returns current prices for one or more symbols.
  // Example: /api/prices?symbols=TONUSDT,BTCUSDT,ETHUSDT
  if (pathname === '/api/prices' && req.method === 'GET') {
    const symbolsParam = urlObj.searchParams.get('symbols');
    if (!symbolsParam) {
      sendJson(res, 400, { error: 'Missing symbols parameter' });
      return true;
    }
    const symbols = symbolsParam.split(',').map(s => s.trim()).filter(Boolean);
    // Fetch price for each symbol in parallel
    Promise.all(
      symbols.map(sym =>
        fetchJsonFromUrl(`https://api.binance.com/api/v3/ticker/price?symbol=${encodeURIComponent(sym)}`)
          .then(data => ({ symbol: sym, price: data.price }))
          .catch(() => ({ symbol: sym, error: 'Failed to fetch' }))
      )
    )
      .then(results => {
        sendJson(res, 200, { prices: results });
      })
      .catch(err => {
        sendJson(res, 500, { error: 'Failed to fetch prices', details: err.message });
      });
    return true;
  }

  // Historical candle endpoint: returns OHLCV data from Binance spot API.
  // Example: /api/candles?symbol=TONUSDT&interval=1d&limit=30
  if (pathname === '/api/candles' && req.method === 'GET') {
    const symbol = urlObj.searchParams.get('symbol');
    const interval = urlObj.searchParams.get('interval');
    const limit = urlObj.searchParams.get('limit') || '100';
    if (!symbol || !interval) {
      sendJson(res, 400, { error: 'Missing symbol or interval parameter' });
      return true;
    }
    const apiUrl = `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${encodeURIComponent(limit)}`;
    fetchJsonFromUrl(apiUrl)
      .then(data => {
        sendJson(res, 200, data);
      })
      .catch(err => {
        sendJson(res, 500, { error: 'Failed to fetch candles', details: err.message });
      });
    return true;
  }

  // Futures candle endpoint: returns OHLCV data from Binance futures API.
  // Example: /api/futures_candles?symbol=TONUSDT&interval=1h&limit=100
  if (pathname === '/api/futures_candles' && req.method === 'GET') {
    const symbol = urlObj.searchParams.get('symbol');
    const interval = urlObj.searchParams.get('interval');
    const limit = urlObj.searchParams.get('limit') || '100';
    if (!symbol || !interval) {
      sendJson(res, 400, { error: 'Missing symbol or interval parameter' });
      return true;
    }
    const apiUrl = `https://fapi.binance.com/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${encodeURIComponent(limit)}`;
    fetchJsonFromUrl(apiUrl)
      .then(data => {
        sendJson(res, 200, data);
      })
      .catch(err => {
        sendJson(res, 500, { error: 'Failed to fetch futures candles', details: err.message });
      });
    return true;
  }

  // Market capitalisation endpoint. Returns the current market cap in TON for
  // a given asset. Expects a query parameter `asset` equal to 'GIFTS' or
  // 'STICKERS'. If the asset is unknown, returns 0. This uses live data
  // from external APIs when available; otherwise it returns 0.
  if (pathname === '/api/market_cap' && req.method === 'GET') {
    const asset = urlObj.searchParams.get('asset');
    if (!asset) {
      sendJson(res, 400, { error: 'Missing asset parameter' });
      return true;
    }
    computeMarketCap(asset.toUpperCase())
      .then(({ capTon }) => {
        sendJson(res, 200, { capTon });
      })
      .catch(err => {
        sendJson(res, 500, { error: 'Failed to compute market cap', details: err.message });
      });
    return true;
  }

  // Deposit address endpoint. Returns the platform's main TON address that
  // users should send TON to when depositing funds. No parameters are
  // required. The address is configured via MAIN_WALLET_ADDRESS.
  if (pathname === '/api/deposit_address' && req.method === 'GET') {
    sendJson(res, 200, { address: MAIN_WALLET_ADDRESS });
    return true;
  }

  // Prediction open endpoint. Creates or joins a binary market for a user.
  // Request body must include `userId`, `asset`, `direction`, `amount` and
  // `expiryMinutes`. The stake (in TON) will be debited from the user's
  // ledger. Returns { success: true, bet, marketId } on success.
  if (pathname === '/api/prediction/open' && req.method === 'POST') {
    parseBody(req, async data => {
      try {
        const userId = data.userId;
        const asset = (data.asset || '').toUpperCase();
        const direction = (data.direction || '').toLowerCase();
        const amount = parseFloat(data.amount);
        const expiryMinutes = parseInt(data.expiryMinutes, 10) || 0;
        if (!userId) throw new Error('userId required');
        if (!asset || !ALLOWED_PREDICTION_ASSETS.includes(asset)) throw new Error('Invalid asset');
        if (!direction || (direction !== 'above' && direction !== 'below')) throw new Error('Invalid direction');
        if (!amount || amount <= 0) throw new Error('Invalid amount');
        if (expiryMinutes <= 0) throw new Error('Invalid expiryMinutes');
        // Debit the stake from user's ledger
        debit(userId, amount);
        // Find or create the market
        const market = await getOrCreateMarket(asset, expiryMinutes);
        // If this is the first bet in a new market, ensure strike is set (already done)
        // Create bet
        const bet = {
          id: nextBetId++,
          userId: String(userId),
          direction,
          stakeTon: amount,
        };
        market.bets.push(bet);
        market.pools[direction] += amount;
        sendJson(res, 200, { success: true, bet, marketId: market.id });
      } catch (err) {
        sendJson(res, 400, { success: false, message: err.message });
      }
    });
    return true;
  }

  // Prediction list endpoint. Returns all markets with optional filter.
  if (pathname === '/api/prediction' && req.method === 'GET') {
    // Optionally filter by userId
    const userId = urlObj.searchParams.get('userId');
    let list = markets;
    if (userId) {
      list = markets.filter(m => m.bets.some(b => b.userId === String(userId)));
    }
    sendJson(res, 200, list);
    return true;
  }

  // Prediction settle endpoint. Settles a market if expired. Request body
  // must include `marketId`. Returns updated market object. If the market
  // has not yet expired, returns an error message.
  if (pathname === '/api/prediction/settle' && req.method === 'POST') {
    parseBody(req, async data => {
      try {
        const marketId = data && Number(data.marketId);
        if (!marketId) throw new Error('Invalid or missing marketId');
        const market = markets.find(m => m.id === marketId);
        if (!market) throw new Error('Market not found');
        if (Date.now() < market.expiry) throw new Error('Market not expired');
        const settled = await settleMarket(market);
        sendJson(res, 200, { success: true, market: settled });
      } catch (err) {
        sendJson(res, 400, { success: false, message: err.message });
      }
    });
    return true;
  }

  // -------------------------------------------------------------------------
  // Admin endpoints
  // These routes allow an administrator to view and process withdrawal
  // requests, inspect markets and the ledger. Access is protected via
  // ADMIN_SECRET. Provide the secret as a query parameter `secret` for GET
  // requests or in the JSON body for POST requests. If the secret is not
  // configured on the server (ADMIN_SECRET is empty), admin endpoints are
  // disabled.

  // List all pending withdrawals
  if (pathname === '/api/admin/withdrawals' && req.method === 'GET') {
    const secret = urlObj.searchParams.get('secret');
    if (!ADMIN_SECRET || secret !== ADMIN_SECRET) {
      sendJson(res, 403, { success: false, message: 'Forbidden' });
      return true;
    }
    sendJson(res, 200, withdrawQueue);
    return true;
  }

  // Process (complete) a withdrawal. Request body must include { id } and
  // optionally a transaction hash or notes. Marks the withdrawal as
  // completed. For a real deployment, this would also trigger sending TON
  // onchain. Requires correct admin secret in the JSON body. Responds with
  // the updated queue entry.
  if (pathname === '/api/admin/withdrawals/process' && req.method === 'POST') {
    parseBody(req, ({ secret, id, txHash }) => {
      if (!ADMIN_SECRET || secret !== ADMIN_SECRET) {
        sendJson(res, 403, { success: false, message: 'Forbidden' });
        return;
      }
      const idx = withdrawQueue.findIndex(w => w.id === id);
      if (idx === -1) {
        sendJson(res, 404, { success: false, message: 'Withdrawal not found' });
        return;
      }
      const entry = withdrawQueue[idx];
      if (entry.status === 'completed') {
        sendJson(res, 200, { success: true, withdrawal: entry });
        return;
      }
      entry.status = 'completed';
      entry.txHash = txHash || null;
      entry.completedAt = Date.now();
      sendJson(res, 200, { success: true, withdrawal: entry });
    });
    return true;
  }

  // List markets for admin analysis
  if (pathname === '/api/admin/markets' && req.method === 'GET') {
    const secret = urlObj.searchParams.get('secret');
    if (!ADMIN_SECRET || secret !== ADMIN_SECRET) {
      sendJson(res, 403, { success: false, message: 'Forbidden' });
      return true;
    }
    sendJson(res, 200, markets);
    return true;
  }

  // List ledger balances for admin. Returns an object mapping userId to
  // balanceTon. Requires admin secret.
  if (pathname === '/api/admin/ledger' && req.method === 'GET') {
    const secret = urlObj.searchParams.get('secret');
    if (!ADMIN_SECRET || secret !== ADMIN_SECRET) {
      sendJson(res, 403, { success: false, message: 'Forbidden' });
      return true;
    }
    const out = {};
    for (const [uid, rec] of ledger.entries()) {
      out[uid] = rec.balanceTon;
    }
    sendJson(res, 200, out);
    return true;
  }

  // Send Telegram WebApp link. This endpoint sends a message to the specified
  // chat_id containing an inline button that opens the mini app. The bot
  // token and web app URL must be configured via BOT_TOKEN and WEBAPP_URL.
  if (pathname === '/api/bot/sendLink' && req.method === 'GET') {
    const chatId = urlObj.searchParams.get('chat_id');
    if (!BOT_TOKEN) {
      sendJson(res, 500, { error: 'BOT_TOKEN is not configured on the server' });
      return true;
    }
    if (!WEBAPP_URL) {
      sendJson(res, 500, { error: 'WEBAPP_URL is not configured on the server' });
      return true;
    }
    if (!chatId) {
      sendJson(res, 400, { error: 'chat_id query parameter is required' });
      return true;
    }
    // Construct the inline keyboard with web_app button
    const messagePayload = {
      chat_id: chatId,
      // Text of the message inviting the user to open the mini app
      text: 'Open @crypto',
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: 'Open @crypto',
              web_app: { url: WEBAPP_URL },
            },
          ],
        ],
      },
    };
    sendTelegram('sendMessage', messagePayload)
      .then(response => {
        sendJson(res, 200, response);
      })
      .catch(err => {
        sendJson(res, 500, { error: 'Failed to send message', details: err.message });
      });
    return true;
  }

  // --------------------------------------------------------------------------
  // Account balance endpoint. Returns the TON balance for a given address.
  // Example: /api/balance?address=<tonAddress>
  // This uses tonapi.io to retrieve the account data. The balance is returned
  // in TON units (decimal). If any error occurs, the balance is 0.
  if (pathname === '/api/balance' && req.method === 'GET') {
    const address = urlObj.searchParams.get('address');
    if (!address) {
      sendJson(res, 400, { error: 'Missing address parameter' });
      return true;
    }
    (async () => {
      try {
        const account = await fetchJsonFromUrl(`https://tonapi.io/v2/accounts/${address}`);
        // The TonAPI returns balance in nanocoins (1 TON = 10^9 nanocoins)
        let balanceTon = 0;
        if (account && typeof account.balance === 'string') {
          balanceTon = parseFloat(account.balance) / 1e9;
        }
        sendJson(res, 200, { balance: balanceTon });
      } catch (err) {
        sendJson(res, 500, { error: 'Failed to fetch balance', details: err.message });
      }
    })();
    return true;
  }

  // Withdraw endpoint. Accepts a POST body with { from, to, amount }.
  // The server does not perform an onchain transfer but returns a mock
  // acknowledgement. In a real implementation, this would create and send
  // a signed transaction on the TON blockchain.
  if (pathname === '/api/withdraw' && req.method === 'POST') {
    parseBody(req, ({ from, to, amount }) => {
      if (!from || !to || !amount || amount <= 0) {
        sendJson(res, 400, { success: false, message: 'Invalid withdrawal request' });
        return;
      }
      // In a real system, here you would build, sign and broadcast a TON
      // transfer transaction from `from` to `to` for `amount` TON. For now
      // return a mock response.
      sendJson(res, 200, {
        success: true,
        message: `Withdrawal of ${amount} TON to ${to} prepared (mock).`,
      });
    });
    return true;
  }

  // ------------------------------------------------------------------------
  // Wallet ledger endpoints
  // GET /api/wallet/balance?userId=<uid> – return user's internal balance
  if (pathname === '/api/wallet/balance' && req.method === 'GET') {
    const uid = urlObj.searchParams.get('userId');
    if (!uid) {
      sendJson(res, 400, { error: 'Missing userId parameter' });
      return true;
    }
    const bal = getBal(uid);
    sendJson(res, 200, { balanceTon: bal });
    return true;
  }

  // POST /api/wallet/deposit/webhook – simulate deposit confirmation. In a real
  // scenario this endpoint would be called by a TON indexer or webhook once
  // a deposit transaction is detected on chain. Accepts { userId, amountTon }.
  if (pathname === '/api/wallet/deposit/webhook' && req.method === 'POST') {
    parseBody(req, ({ userId, amountTon }) => {
      try {
        const amt = Number(amountTon);
        if (!userId || !amt || amt <= 0) {
          sendJson(res, 400, { success: false, message: 'Invalid deposit' });
          return;
        }
        credit(userId, amt);
        sendJson(res, 200, { success: true, balanceTon: getBal(userId) });
      } catch (err) {
        sendJson(res, 400, { success: false, message: err.message });
      }
    });
    return true;
  }

  // GET /api/wallet/limits?userId=<uid> – return how much the user has
  // withdrawn in the last day and month, along with remaining allowances.
  if (pathname === '/api/wallet/limits' && req.method === 'GET') {
    const uid = urlObj.searchParams.get('userId');
    if (!uid) {
      sendJson(res, 400, { error: 'Missing userId parameter' });
      return true;
    }
    const { dailyUsed, monthlyUsed } = getWithdrawUsage(uid);
    const dailyRemaining = Math.max(0, WITHDRAW_LIMIT_DAILY - dailyUsed);
    const monthlyRemaining = Math.max(0, WITHDRAW_LIMIT_MONTHLY - monthlyUsed);
    sendJson(res, 200, {
      daily: { used: dailyUsed, remaining: dailyRemaining, limit: WITHDRAW_LIMIT_DAILY },
      monthly: { used: monthlyUsed, remaining: monthlyRemaining, limit: WITHDRAW_LIMIT_MONTHLY },
    });
    return true;
  }

  // POST /api/wallet/withdraw – withdraw from internal ledger. Accepts
  // { userId, to, amountTon }. Applies a platform fee and enforces daily
  // (WITHDRAW_LIMIT_DAILY) and monthly (WITHDRAW_LIMIT_MONTHLY) limits. If
  // limits are exceeded, returns an error. On success, debits the user's
  // ledger by the gross amount, records the withdrawal in the log, and
  // returns the gross, fee and net amounts along with updated limit usage.
  if (pathname === '/api/wallet/withdraw' && req.method === 'POST') {
    parseBody(req, ({ userId, to, amountTon }) => {
      try {
        const amt = Number(amountTon);
        if (!userId || !to || !amt || amt <= 0) {
          sendJson(res, 400, { success: false, message: 'Invalid withdrawal request' });
          return;
        }
        // Enforce limits per user
        const { dailyUsed, monthlyUsed } = getWithdrawUsage(userId);
        if (amt + dailyUsed > WITHDRAW_LIMIT_DAILY) {
          const remaining = Math.max(0, WITHDRAW_LIMIT_DAILY - dailyUsed);
          sendJson(res, 400, {
            success: false,
            message: 'Daily withdrawal limit exceeded',
            dailyLimit: WITHDRAW_LIMIT_DAILY,
            dailyUsed,
            dailyRemaining: remaining,
          });
          return;
        }
        if (amt + monthlyUsed > WITHDRAW_LIMIT_MONTHLY) {
          const remaining = Math.max(0, WITHDRAW_LIMIT_MONTHLY - monthlyUsed);
          sendJson(res, 400, {
            success: false,
            message: 'Monthly withdrawal limit exceeded',
            monthlyLimit: WITHDRAW_LIMIT_MONTHLY,
            monthlyUsed,
            monthlyRemaining: remaining,
          });
          return;
        }
        // Compute fee and net
        const feeTon = amt * WITHDRAW_FEE_RATE;
        const netTon = amt - feeTon;
        // Debit full amount from internal ledger
        debit(userId, amt);
        // Record the withdrawal in the limit log
        const now = Date.now();
        const uid = String(userId);
        const userLog = withdrawalLog.get(uid) || [];
        userLog.push({ ts: now, amountTon: amt });
        withdrawalLog.set(uid, userLog);
        // Generate a unique request ID
        const requestId = `wd_${Date.now().toString(16)}`;
        // Push a pending request into the withdrawal queue for admin
        withdrawQueue.push({
          id: requestId,
          userId: uid,
          amountTon: amt,
          feeTon,
          netTon,
          to,
          status: 'pending',
          requestedAt: now,
        });
        // Updated usage after this withdrawal
        const newDailyUsed = dailyUsed + amt;
        const newMonthlyUsed = monthlyUsed + amt;
        const dailyRemaining = Math.max(0, WITHDRAW_LIMIT_DAILY - newDailyUsed);
        const monthlyRemaining = Math.max(0, WITHDRAW_LIMIT_MONTHLY - newMonthlyUsed);
        sendJson(res, 200, {
          success: true,
          requestId,
          to,
          amountTon: amt,
          feeTon,
          netTon,
          from: MAIN_WALLET_ADDRESS,
          status: 'pending',
          daily: {
            used: newDailyUsed,
            remaining: dailyRemaining,
            limit: WITHDRAW_LIMIT_DAILY,
          },
          monthly: {
            used: newMonthlyUsed,
            remaining: monthlyRemaining,
            limit: WITHDRAW_LIMIT_MONTHLY,
          },
        });
      } catch (err) {
        sendJson(res, 400, { success: false, message: err.message });
      }
    });
    return true;
  }

  // -------------------------------------------------------------------------
  // ADMIN API ENDPOINTS
  //
  // These endpoints provide administrative access to pending withdrawals,
  // markets and the internal ledger. They require a valid admin secret to
  // be supplied via the `X-Admin-Secret` header or the `secret` query
  // parameter. If ADMIN_SECRET is unset, all admin endpoints will return
  // unauthorized.

  // GET /api/admin/withdrawals – list all withdrawal requests currently
  // in the queue (pending or processed). Returns an array of objects.
  if (pathname === '/api/admin/withdrawals' && req.method === 'GET') {
    const urlObj = new URL(req.url, 'http://localhost');
    const secret = req.headers['x-admin-secret'] || urlObj.searchParams.get('secret');
    if (!ADMIN_SECRET || secret !== ADMIN_SECRET) {
      sendJson(res, 403, { success: false, message: 'Unauthorized' });
      return true;
    }
    sendJson(res, 200, { success: true, withdrawals: withdrawQueue });
    return true;
  }

  // POST /api/admin/withdrawals/process – mark a pending withdrawal as completed.
  // Expects JSON body { id: string }. Returns the updated withdrawal object.
  if (pathname === '/api/admin/withdrawals/process' && req.method === 'POST') {
    parseBody(req, ({ id }) => {
      const urlObj = new URL(req.url, 'http://localhost');
      const secret = req.headers['x-admin-secret'] || urlObj.searchParams.get('secret');
      if (!ADMIN_SECRET || secret !== ADMIN_SECRET) {
        sendJson(res, 403, { success: false, message: 'Unauthorized' });
        return;
      }
      const idx = withdrawQueue.findIndex(w => w.id === id);
      if (idx === -1) {
        sendJson(res, 404, { success: false, message: 'Withdrawal not found' });
        return;
      }
      if (withdrawQueue[idx].status !== 'pending') {
        sendJson(res, 400, { success: false, message: 'Withdrawal already processed' });
        return;
      }
      withdrawQueue[idx].status = 'completed';
      withdrawQueue[idx].processedAt = Date.now();
      sendJson(res, 200, { success: true, withdrawal: withdrawQueue[idx] });
    });
    return true;
  }

  // GET /api/admin/markets – return the list of prediction markets and bets.
  if (pathname === '/api/admin/markets' && req.method === 'GET') {
    const urlObj = new URL(req.url, 'http://localhost');
    const secret = req.headers['x-admin-secret'] || urlObj.searchParams.get('secret');
    if (!ADMIN_SECRET || secret !== ADMIN_SECRET) {
      sendJson(res, 403, { success: false, message: 'Unauthorized' });
      return true;
    }
    const summary = markets.map(m => ({
      id: m.id,
      asset: m.asset,
      strike: m.strike,
      expiry: m.expiry,
      status: m.status,
      pools: m.pools,
      feeCollected: m.feeCollected,
      bets: m.bets.map(b => ({ id: b.id, userId: b.userId, direction: b.direction, stakeTon: b.stakeTon, grossStake: b.grossStake, entryFee: b.entryFee })),
    }));
    sendJson(res, 200, { success: true, markets: summary });
    return true;
  }

  // GET /api/admin/ledger – return the in‑memory ledger of user balances.
  if (pathname === '/api/admin/ledger' && req.method === 'GET') {
    const urlObj = new URL(req.url, 'http://localhost');
    const secret = req.headers['x-admin-secret'] || urlObj.searchParams.get('secret');
    if (!ADMIN_SECRET || secret !== ADMIN_SECRET) {
      sendJson(res, 403, { success: false, message: 'Unauthorized' });
      return true;
    }
    const entries = [];
    for (const [uid, rec] of ledger.entries()) {
      entries.push({ userId: uid, balanceTon: rec.balanceTon });
    }
    sendJson(res, 200, { success: true, ledger: entries });
    return true;
  }

  return false;
}

// Determine MIME type based on file extension
function getMimeType(ext) {
  switch (ext) {
    case '.html': return 'text/html';
    case '.js': return 'application/javascript';
    case '.css': return 'text/css';
    case '.json': return 'application/json';
    case '.png': return 'image/png';
    case '.jpg': return 'image/jpeg';
    case '.ico': return 'image/x-icon';
    default: return 'text/plain';
  }
}

// Serve static files from the public directory
function serveStatic(req, res) {
  let filePath = req.url;
  if (filePath === '/' || filePath === '') {
    filePath = '/index.html';
  }
  const resolvedPath = path.join(__dirname, 'public', decodeURIComponent(filePath));
  // Prevent directory traversal attacks
  const publicRoot = path.join(__dirname, 'public');
  if (!resolvedPath.startsWith(publicRoot)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(resolvedPath, (err, content) => {
    if (err) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    const ext = path.extname(resolvedPath);
    const mime = getMimeType(ext);
    res.writeHead(200, { 'Content-Type': mime });
    res.end(content);
  });
}

// Create and start the server
const server = http.createServer((req, res) => {
  // First, handle API routes
  if (handleApi(req, res)) return;
  // Otherwise, serve static content
  serveStatic(req, res);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`@crypto server running at http://localhost:${PORT}/`);
});
