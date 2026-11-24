import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  privateUploadOrigin,
  screenshotGrantMs,
  screenshotLimit,
  screenshotPath,
  screenshotPort,
} from '../shared/screenshot.ts';
import { uploadPage } from './upload-page.ts';

import { isScreenshot, type ScreenshotType } from './image.ts';
type Target = { workspaceId: string; itemId: string };
type Grant = Target & { origin: string; expires: number; receiving: boolean };
const loopback = '127.0.0.1';
const maxGrants = 128;

function send(response: ServerResponse, status: number, message = '') {
  if (status >= 400) response.setHeader('Connection', 'close');
  response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end(message);
}

export function createScreenshotUpload(
  attach: (workspaceId: string, itemId: string, mime: ScreenshotType, bytes: Buffer) => Promise<void>,
  { port = screenshotPort, now = Date.now }: { port?: number; now?: () => number } = {},
) {
  const grants = new Map<string, Grant>();
  let privateOrigin: string | null = null;
  let listener: Promise<string> | undefined;
  let stopped = false;

  function requestOrigin(request: IncomingMessage): string | null {
    if (request.socket.remoteAddress !== loopback || request.headers['tailscale-funnel-request']) return null;
    const { host } = request.headers;
    const address = server.address() as AddressInfo;
    const localHost = `${loopback}:${address.port}`;
    const forwardedHost = request.headers['x-forwarded-host'];
    const forwardedProto = request.headers['x-forwarded-proto'];
    const login = request.headers['tailscale-user-login'];
    if (host === localHost && !forwardedHost && !forwardedProto && !login) {
      return `http://${localHost}`;
    }
    if (privateOrigin && host === new URL(privateOrigin).host && forwardedHost === host &&
      forwardedProto === 'https' && typeof login === 'string' && login.trim()) {
      return privateOrigin;
    }
    return null;
  }

  async function receive(request: IncomingMessage, response: ServerResponse) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    const origin = requestOrigin(request);
    if (!origin || request.url !== screenshotPath) return send(response, 404, 'Upload page unavailable.');

    if (request.method === 'GET') {
      const nonce = randomBytes(18).toString('base64');
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      });
      return response.end(uploadPage(nonce));
    }
    if (request.method !== 'POST') return send(response, 405, 'Only screenshots can be attached here.');
    if (request.headers.origin !== origin ||
      (request.headers['sec-fetch-site'] && request.headers['sec-fetch-site'] !== 'same-origin')) {
      return send(response, 403, 'Open the screenshot link from Task Inbox.');
    }

    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization ?? '')?.[1];
    const grant = token && grants.get(token);
    if (!grant || !token || grant.origin !== origin || grant.expires <= now()) {
      return send(response, 410, 'This link expired or was used. Open a fresh link from Task Inbox.');
    }
    if (grant.receiving) return send(response, 409, 'This link already has an upload in progress.');
    const mime = request.headers['content-type'];
    if ((mime !== 'image/png' && mime !== 'image/jpeg') || request.headers['content-encoding']) {
      return send(response, 415, 'Choose a PNG or JPEG screenshot.');
    }
    if (Number(request.headers['content-length']) > screenshotLimit) {
      return send(response, 413, 'Choose a screenshot up to 8 MB.');
    }

    grant.receiving = true;
    try {
      const chunks: Buffer[] = [];
      let length = 0;
      // Leave the socket available to flush an error if a streamed body crosses the limit.
      for await (const chunk of request.iterator({ destroyOnReturn: false })) {
        length += chunk.length;
        if (length > screenshotLimit) {
          response.setHeader('Connection', 'close');
          return send(response, 413, 'Choose a screenshot up to 8 MB.');
        }
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks, length);
      if (!isScreenshot(bytes, mime)) return send(response, 415, 'The file must be a PNG or JPEG screenshot.');
      if (grant.expires <= now() || grants.get(token) !== grant) {
        return send(response, 410, 'This link expired. Open a fresh link from Task Inbox.');
      }

      grants.delete(token);
      try {
        await attach(grant.workspaceId, grant.itemId, mime, bytes);
      } catch {
        return send(response, 409, 'Screenshot could not be attached. Check the item in Task Inbox.');
      }
      return send(response, 204);
    } finally {
      grant.receiving = false;
    }
  }

  const server = createServer({ requestTimeout: 30_000, headersTimeout: 10_000 }, (request, response) => {
    void receive(request, response).catch(() => {
      if (!response.headersSent) send(response, 400, 'Upload interrupted. Try again.');
      else response.end();
    });
  });
  server.maxConnections = 20;
  server.setTimeout(15_000, (socket) => socket.destroy());

  function localOrigin() {
    if (stopped) throw new Error('The screenshot service has stopped.');
    listener ??= new Promise<string>((resolve, reject) => {
      const onError = () => {
        listener = undefined;
        reject(new Error(`The screenshot service could not open port ${port} on this host.`));
      };
      server.once('error', onError);
      server.listen(port, loopback, () => {
        server.off('error', onError);
        const address = server.address() as AddressInfo;
        resolve(`http://${loopback}:${address.port}`);
      });
    });
    return listener;
  }

  return {
    configure(value: string) {
      const next = privateUploadOrigin(value);
      if (privateOrigin === next) return;
      for (const [token, grant] of grants) {
        if (grant.origin === privateOrigin) grants.delete(token);
      }
      privateOrigin = next;
    },
    async grant(target: Target, allowLoopback: boolean): Promise<{ url: string }> {
      if (!privateOrigin && !allowLoopback) {
        throw new Error('Set this host’s private Tailscale address in Task Inbox settings to attach from your device.');
      }
      const local = await localOrigin();
      if (stopped) throw new Error('The screenshot service has stopped.');
      const origin = privateOrigin ?? (allowLoopback ? local : null);
      if (!origin) throw new Error('The host’s private screenshot address changed. Try again.');
      const time = now();
      for (const [token, grant] of grants) {
        if (grant.expires <= time) grants.delete(token);
      }
      if (grants.size >= maxGrants) throw new Error('Too many open screenshot links. Try again in a few minutes.');
      const token = randomBytes(32).toString('base64url');
      grants.set(token, { ...target, origin, expires: time + screenshotGrantMs, receiving: false });
      return { url: `${origin}${screenshotPath}#${token}` };
    },
    async close() {
      stopped = true;
      grants.clear();
      await listener?.catch(() => {});
      if (!server.listening) return;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
