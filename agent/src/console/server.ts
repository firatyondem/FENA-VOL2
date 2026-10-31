// Serves the console and streams the explanation log. It listens on localhost only and has no write routes: the console
// watches the agent, it never steers it. Pages on the allowed origins (the frontend) may read the log too, and fetch a
// fresh signed price for a manual sell.
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { SignedResponse } from '../airnode/attestation.ts';
import type { EventLog } from '../log.ts';

export interface ConsoleServerOptions {
  log: EventLog;
  // The agent's clock in seconds, which the replay runs faster than real time
  now: () => number;
  port?: number;
  host?: string;
  clockIntervalMs?: number;
  // Origins whose pages may read /api/state, /api/stream and /api/signed-price
  allowedOrigins?: readonly string[];
  // Signed prices for the frontend's manual sell; without them /api/signed-price answers 404
  prices?: { assets: readonly string[]; fetch: (asset: string) => Promise<SignedResponse> };
  // One signed price answers every request for its asset this long: at most one (paid) fetch per asset per window
  priceCacheMs?: number;
  // /api/state sends at most this many of the newest events, so the console and the frontend stay fast
  stateEvents?: number;
  // The agent's schedule, mode, budgets and totals for the Engine Room: in /api/state and with every clock tick
  status?: () => unknown;
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

export const startConsoleServer = ({
  log,
  now,
  port = 4173,
  host = '127.0.0.1',
  clockIntervalMs = 1000,
  allowedOrigins = DEFAULT_ALLOWED_ORIGINS,
  prices,
  priceCacheMs = 10_000,
  stateEvents = 1000,
  status,
}: ConsoleServerOptions): Promise<Server> => {
  const streams = new Set<ServerResponse>();
  // Event numbers restart with the agent, so a page that reconnects after a restart must start over
  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  // Read-only routes, so a plain GET from an allowed origin needs no preflight
  const corsHeaders = (request: IncomingMessage): Record<string, string> => {
    const origin = request.headers.origin;
    return origin && allowedOrigins.includes(origin) ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : { Vary: 'Origin' };
  };

  const sendState = (request: IncomingMessage, response: ServerResponse) => {
    response.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...SECURITY_HEADERS,
      ...corsHeaders(request),
    });
    response.end(
      JSON.stringify({
        runId,
        now: now(),
        signedPrices: Boolean(prices),
        ...(status ? { status: status() } : {}),
        events: log.recent(stateEvents),
      })
    );
  };

  // A failed fetch stays cached for its window too, so a paid source is never asked again sooner
  const priceCache = new Map<string, { at: number; response: Promise<SignedResponse> }>();
  const sendPrice = async (request: IncomingMessage, response: ServerResponse, asset: string) => {
    const reply = (status: number, body: unknown) => {
      response.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...SECURITY_HEADERS,
        ...corsHeaders(request),
      });
      response.end(JSON.stringify(body));
    };
    if (!prices) return reply(404, { error: 'This agent serves no signed prices' });
    if (!prices.assets.includes(asset)) return reply(400, { error: `Unknown asset "${asset}"` });
    let cached = priceCache.get(asset);
    if (!cached || Date.now() - cached.at >= priceCacheMs) {
      cached = { at: Date.now(), response: prices.fetch(asset) };
      cached.response.catch(() => {}); // answered below; this only keeps a rejection from going unhandled
      priceCache.set(asset, cached);
    }
    try {
      reply(200, { asset, response: await cached.response });
    } catch (error) {
      reply(502, { error: `No signed price for ${asset}: ${(error as Error).message}` });
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
    if (request.method !== 'GET') {
      response.writeHead(405, { Allow: 'GET', ...SECURITY_HEADERS }).end();
      return;
    }
    if (path === '/api/state') return sendState(request, response);
    if (path === '/api/stream') return openStream(request, response);
    if (path === '/api/signed-price') return sendPrice(request, response, url.searchParams.get('asset') ?? '');
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
