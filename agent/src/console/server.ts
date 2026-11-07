// Serves the console, streams the explanation log, and answers the website's API: health, costs, decisions, Pyth price
// updates for a manual sell, the tamper set and the demo faucet. Pages on the allowed origins (the website) may call it;
// everything else gets no CORS headers. The only write is the faucet, which has its own daily limits.
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Hex } from 'viem';
import { type EventLog, redactUrls } from '../log.ts';
import type { PriceUpdate } from '../pyth/hermes.ts';
import type { DecisionLog } from '../store/decisions.ts';
import type { CostLedger } from '../store/ledger.ts';

export interface HealthReport {
  ok: boolean;
  // Milliseconds since the epoch, or null before the first poll
  lastPollAt: number | null;
  version: string;
  mode?: string;
}

export interface TamperCase {
  name: string;
  how: string;
  // The vault's error name for a forgery, or "accepted"
  expected: string;
  // The update's bytes, as checkPrice takes them
  update: Hex[];
}

export interface FaucetPort {
  drip(address: string): Promise<{ address: string; ethTx: string; usdcTx: string; eth: bigint; usdc: bigint }>;
}

export interface ConsoleServerOptions {
  log: EventLog;
  // The agent's clock in seconds, which the replay runs faster than real time
  now: () => number;
  port?: number;
  host?: string;
  clockIntervalMs?: number;
  // Origins whose pages may call the API
  allowedOrigins?: readonly string[];
  // Pyth updates for the website's manual sell; without them /api/price-update answers 404
  prices?: { assets: readonly string[]; latest: (asset: string) => Promise<PriceUpdate>; fee?: (update: PriceUpdate) => Promise<bigint> };
  // /api/state sends at most this many of the newest events, so the console and the frontend stay fast
  stateEvents?: number;
  // The agent's schedule, mode, budgets and totals for the Engine Room: in /api/state and with every clock tick
  status?: () => unknown;
  health?: () => HealthReport;
  costs?: CostLedger;
  decisions?: DecisionLog;
  faucet?: FaucetPort;
  // The tamper test's updates for an asset: a real fresh one, then its forgeries
  tamper?: { assets: readonly string[]; build: (asset: string) => Promise<TamperCase[]> };
}

export const DEFAULT_ALLOWED_ORIGINS = ['http://localhost:8000'];

const PUBLIC = new URL('./public/', import.meta.url);
const STATIC: Record<string, [file: string, type: string]> = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/console.css': ['console.css', 'text/css; charset=utf-8'],
  '/console.js': ['console.js', 'text/javascript; charset=utf-8'],
  '/view-model.js': ['view-model.js', 'text/javascript; charset=utf-8'],
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data:",
};

const MAX_BODY_BYTES = 1024;

const json = (value: unknown) => JSON.stringify(value, (_key, field) => (typeof field === 'bigint' ? field.toString() : field));

const readBody = (request: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
      if (body.length > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        request.destroy();
      }
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });

const clampInt = (value: string | null, fallback: number, min: number, max: number) => {
  const number = Number(value ?? fallback);
  return Number.isInteger(number) ? Math.min(max, Math.max(min, number)) : fallback;
};

const isUser = (user: string) => user === '*' || /^0x[0-9a-fA-F]{40}$/.test(user);

export const startConsoleServer = ({
  log,
  now,
  port = 4173,
  host = '127.0.0.1',
  clockIntervalMs = 1000,
  allowedOrigins = DEFAULT_ALLOWED_ORIGINS,
  prices,
  stateEvents = 1000,
  status,
  health,
  costs,
  decisions,
  faucet,
  tamper,
}: ConsoleServerOptions): Promise<Server> => {
  const streams = new Set<ServerResponse>();
  // Event numbers restart with the agent, so a page that reconnects after a restart must start over
  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  const corsHeaders = (request: IncomingMessage): Record<string, string> => {
    const origin = request.headers.origin;
    return origin && allowedOrigins.includes(origin) ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : { Vary: 'Origin' };
  };

  const replyJson = (request: IncomingMessage, response: ServerResponse, code: number, body: unknown) => {
    response.writeHead(code, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...SECURITY_HEADERS,
      ...corsHeaders(request),
    });
    response.end(json(body));
  };

  const sendState = (request: IncomingMessage, response: ServerResponse) =>
    replyJson(request, response, 200, {
      runId,
      now: now(),
      priceUpdates: Boolean(prices),
      ...(status ? { status: status() } : {}),
      events: log.recent(stateEvents),
    });

  const sendPriceUpdate = async (request: IncomingMessage, response: ServerResponse, asset: string) => {
    if (!prices) return replyJson(request, response, 404, { error: 'This agent serves no price updates' });
    if (!prices.assets.includes(asset)) return replyJson(request, response, 400, { error: `Unknown asset "${asset}"` });
    try {
      const update = await prices.latest(asset);
      const fee = prices.fee ? await prices.fee(update) : undefined;
      replyJson(request, response, 200, {
        asset,
        // Pass `updates` to sell(positionId, Manual, updates) with `fee` wei as the value
        updates: update.updates,
        ...(fee === undefined ? {} : { fee }),
        prices: update.prices,
      });
    } catch (error) {
      replyJson(request, response, 502, { error: `No price update for ${asset}: ${redactUrls((error as Error).message)}` });
    }
  };

  const sendTamperSet = async (request: IncomingMessage, response: ServerResponse, asset: string) => {
    if (!tamper) return replyJson(request, response, 404, { error: 'This agent serves no tamper set' });
    if (!tamper.assets.includes(asset)) {
      return replyJson(request, response, 400, { error: `No tamper set for "${asset}"; there is one for ${tamper.assets.join(', ')}` });
    }
    try {
      replyJson(request, response, 200, { asset, cases: await tamper.build(asset) });
    } catch (error) {
      replyJson(request, response, 502, { error: `No tamper set for ${asset}: ${redactUrls((error as Error).message)}` });
    }
  };

  const sendCosts = (request: IncomingMessage, response: ServerResponse, url: URL) => {
    if (!costs) return replyJson(request, response, 404, { error: 'This agent keeps no cost ledger' });
    const user = url.searchParams.get('user') ?? '';
    if (!isUser(user)) return replyJson(request, response, 400, { error: 'Pass user=0x... (or user=* for all)' });
    replyJson(request, response, 200, costs.report(user, clampInt(url.searchParams.get('days'), 7, 1, 90)));
  };

  const sendDecisions = (request: IncomingMessage, response: ServerResponse, url: URL) => {
    if (!decisions) return replyJson(request, response, 404, { error: 'This agent keeps no decision log' });
    const user = url.searchParams.get('user') ?? '';
    if (!isUser(user)) return replyJson(request, response, 400, { error: 'Pass user=0x... (or user=* for all)' });
    replyJson(request, response, 200, {
      user: user.toLowerCase(),
      decisions: decisions.list(user, clampInt(url.searchParams.get('limit'), 50, 1, 500)),
    });
  };

  const runFaucet = async (request: IncomingMessage, response: ServerResponse) => {
    if (!faucet) return replyJson(request, response, 404, { error: 'This agent runs no faucet' });
    let address: string;
    try {
      address = (JSON.parse(await readBody(request)) as { address?: string }).address ?? '';
    } catch {
      return replyJson(request, response, 400, { error: 'Send {"address": "0x..."} as JSON' });
    }
    try {
      replyJson(request, response, 200, await faucet.drip(address));
    } catch (error) {
      const code = (error as { status?: number }).status ?? 502;
      replyJson(request, response, code, { error: redactUrls((error as Error).message) });
    }
  };

  const openStream = (request: IncomingMessage, response: ServerResponse) => {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      ...SECURITY_HEADERS,
      ...corsHeaders(request),
    });
    response.write(`event: hello\ndata: ${JSON.stringify({ runId })}\n\n`);
    const since = Number(new URL(request.url ?? '/', 'http://localhost').searchParams.get('since') ?? 0);
    for (const event of log.since(Number.isFinite(since) ? since : 0)) {
      response.write(`event: agent-event\ndata: ${JSON.stringify(event)}\n\n`);
    }
    streams.add(response);
    request.on('close', () => streams.delete(response));
  };

  const unsubscribe = log.subscribe((event) => {
    for (const stream of streams) stream.write(`event: agent-event\ndata: ${JSON.stringify(event)}\n\n`);
  });
  const clock = setInterval(() => {
    if (streams.size === 0) return;
    const tick = JSON.stringify({ now: now(), ...(status ? { status: status() } : {}) });
    for (const stream of streams) stream.write(`event: clock\ndata: ${tick}\n\n`);
  }, clockIntervalMs);
  clock.unref();

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const path = url.pathname;
    if (path === '/api/demo/faucet') {
      if (request.method === 'OPTIONS') {
        response.writeHead(204, {
          ...corsHeaders(request),
          'Access-Control-Allow-Methods': 'POST',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '600',
        });
        return response.end();
      }
      if (request.method === 'POST') return runFaucet(request, response);
      response.writeHead(405, { Allow: 'POST, OPTIONS', ...SECURITY_HEADERS }).end();
      return;
    }
    if (request.method !== 'GET') {
      response.writeHead(405, { Allow: 'GET', ...SECURITY_HEADERS }).end();
      return;
    }
    if (path === '/api/health') {
      const report = health?.() ?? { ok: true, lastPollAt: null, version: 'unknown' };
      return replyJson(request, response, report.ok ? 200 : 503, report);
    }
    if (path === '/api/state') return sendState(request, response);
    if (path === '/api/stream') return openStream(request, response);
    if (path === '/api/costs') return sendCosts(request, response, url);
    if (path === '/api/decisions') return sendDecisions(request, response, url);
    if (path === '/api/price-update') return sendPriceUpdate(request, response, url.searchParams.get('asset') ?? '');
    if (path === '/api/tamper-set') return sendTamperSet(request, response, url.searchParams.get('asset') ?? '');
    const asset = STATIC[path];
    if (!asset) {
      response.writeHead(404, { 'Content-Type': 'text/plain', ...SECURITY_HEADERS }).end('Not found');
      return;
    }
    const body = await readFile(new URL(asset[0], PUBLIC));
    response.writeHead(200, { 'Content-Type': asset[1], 'Cache-Control': 'no-cache', ...SECURITY_HEADERS });
    response.end(body);
  });

  server.on('close', () => {
    unsubscribe();
    clearInterval(clock);
    for (const stream of streams) stream.end();
  });

  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
};
