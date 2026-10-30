// Serves the console and streams the explanation log. It listens on localhost only and has no write routes: the console
// watches the agent, it never steers it.
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { EventLog } from '../log.ts';

export interface ConsoleServerOptions {
  log: EventLog;
  // The agent's clock in seconds, which the replay runs faster than real time
  now: () => number;
  port?: number;
  host?: string;
  clockIntervalMs?: number;
}

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
}: ConsoleServerOptions): Promise<Server> => {
  const streams = new Set<ServerResponse>();
  // Event numbers restart with the agent, so a page that reconnects after a restart must start over
  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  const sendState = (response: ServerResponse) => {
    response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
    response.end(JSON.stringify({ runId, now: now(), events: log.recent() }));
  };

  const openStream = (request: IncomingMessage, response: ServerResponse) => {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      ...SECURITY_HEADERS,
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
    for (const stream of streams) stream.write(`event: clock\ndata: ${JSON.stringify({ now: now() })}\n\n`);
  }, clockIntervalMs);
  clock.unref();

  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (request.method !== 'GET') {
      response.writeHead(405, { Allow: 'GET', ...SECURITY_HEADERS }).end();
      return;
    }
    if (path === '/api/state') return sendState(response);
    if (path === '/api/stream') return openStream(request, response);
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
