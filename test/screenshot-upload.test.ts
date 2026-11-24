import assert from 'node:assert/strict';
import { request, type IncomingHttpHeaders, type OutgoingHttpHeaders } from 'node:http';
import { test } from 'node:test';
import { URL } from 'node:url';
import { privateUploadOrigin, screenshotGrantMs, screenshotLimit } from '../shared/screenshot.ts';
import { createScreenshotUpload } from '../server/upload.ts';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=',
  'base64',
);
const jpeg = Buffer.from(
  '/9j/4AAQSkZJRgABAQAASABIAAD/wAALCAABAAEBAREA/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8' +
    'QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJico' +
    'KSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqr' +
    'KztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9sAQwACAgICAgIDAgIDBQMDAwUG' +
    'BQUFBQYIBgYGBgYICggICAgICAoKCgoKCgoKDAwMDAwMDg4ODg4PDw8PDw8PDw8P/90ABAAB/9oACAEBAAA/AP38r/' +
    '/Z',
  'base64',
);
const target = { workspaceId: 'workspace-private', itemId: 'bug-private' };

function send(
  url: URL,
  { method = 'GET', origin = url.origin, headers = {}, body }: {
    method?: string;
    origin?: string;
    headers?: OutgoingHttpHeaders;
    body?: Buffer;
  } = {},
) {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; content: string }>((resolve, reject) => {
    const req = request(url, {
      method,
      headers: {
        ...(method === 'POST' ? { Origin: origin, 'Content-Type': 'image/png' } : {}),
        ...(body ? { 'Content-Length': body.length } : {}),
        ...headers,
      },
    }, (res) => {
      res.setEncoding('utf8');
      let content = '';
      res.on('data', (chunk) => { content += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, content }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('screenshot URL grants are scoped, validated, and consumed exactly once', async (t) => {
  let attached: [string, string, string, Buffer] | undefined;
  const uploader = createScreenshotUpload(async (...args) => { attached = args; }, { port: 0 });
  t.after(() => uploader.close());
  const { url } = await uploader.grant(target, true);
  assert.ok(!url.includes(target.workspaceId) && !url.includes(target.itemId));
  const link = new URL(url);
  const authorization = 'Bearer ' + link.hash.slice(1);
  const page = await send(link);
  assert.equal(page.status, 200);
  assert.match(String(page.headers['content-security-policy']), /default-src 'none'/);
  assert.equal(page.headers['referrer-policy'], 'no-referrer');
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.ok(!page.content.includes(link.hash.slice(1)));
  assert.match(page.content, /history\.replaceState/);

  const upload = (overrides: Parameters<typeof send>[1] = {}) => send(link, {
    method: 'POST', body: png, ...overrides,
    headers: { authorization, ...overrides.headers },
  });
  assert.equal((await upload({ origin: 'https://another.example' })).status, 403);
  assert.equal((await upload({ headers: { Host: 'rebinding.example' } })).status, 404);
  assert.equal((await upload({ headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await upload({ body: Buffer.from('<svg/>') })).status, 415);
  const damaged = Buffer.from(png);
  damaged[49] ^= 1;
  assert.equal((await upload({ body: damaged })).status, 415);
  assert.equal((await upload({ headers: { 'Content-Length': screenshotLimit + 1 } })).status, 413);
  assert.equal((await upload({ headers: { 'Content-Type': 'image/svg+xml' } })).status, 415);
  assert.equal(attached, undefined);
  assert.equal((await upload()).status, 204);
  assert.deepEqual(attached, [target.workspaceId, target.itemId, 'image/png', png]);
  assert.equal((await upload()).status, 410);
});

test('remote screenshot access requires configured HTTPS Serve identity and origin', async (t) => {
  let time = 0;
  let count = 0;
  const uploader = createScreenshotUpload(async (_workspace, _item, mime, bytes) => {
    assert.equal(mime, 'image/jpeg');
    assert.deepEqual(bytes, jpeg);
    count++;
  }, { port: 0, now: () => time });
  t.after(() => uploader.close());
  await assert.rejects(uploader.grant(target, false), /private Tailscale address/);
  const local = new URL((await uploader.grant(target, true)).url);
  const privateOrigin = 'https://the-host.the-tailnet.ts.net:8443';
  uploader.configure(privateOrigin);
  const remote = new URL((await uploader.grant(target, false)).url);
  assert.equal(remote.origin, privateOrigin);
  const headers = {
    Host: remote.host,
    'X-Forwarded-Host': remote.host,
    'X-Forwarded-Proto': 'https',
    'Tailscale-User-Login': 'user@example.invalid',
    Authorization: 'Bearer ' + remote.hash.slice(1),
  };
  assert.equal((await send(local, { headers: { ...headers, 'Tailscale-User-Login': '' } })).status, 404);
  assert.equal((await send(local, { headers: { ...headers, 'Tailscale-Funnel-Request': '?1' } })).status, 404);
  assert.equal((await send(local, { headers: { ...headers, Host: local.host } })).status, 404);
  assert.equal((await send(local, { headers: { ...headers, 'X-Forwarded-Host': local.host } })).status, 404);
  assert.equal((await send(local, { headers })).status, 200);
  assert.equal((await send(local, {
    method: 'POST', body: png, headers: { Authorization: headers.Authorization },
  })).status, 410);
  time = screenshotGrantMs;
  assert.equal((await send(local, { method: 'POST', origin: remote.origin, body: png, headers })).status, 410);
  assert.equal(count, 0);
  const replacement = new URL((await uploader.grant(target, false)).url);
  const accepted = await send(local, {
    method: 'POST', origin: remote.origin, body: jpeg,
    headers: { ...headers, 'Content-Type': 'image/jpeg', Authorization: 'Bearer ' + replacement.hash.slice(1) },
  });
  assert.equal(accepted.status, 204);
  assert.equal(count, 1);
});

test('screenshot settings accept only a Tailscale HTTPS authority', () => {
  assert.equal(privateUploadOrigin('https://THE-HOST.The-Tailnet.ts.net:443/'), 'https://the-host.the-tailnet.ts.net');
  for (const invalid of [
    'http://host.tailnet.ts.net', 'https://public.example.com', 'https://host.tailnet.ts.net/?',
    'https://user@host.tailnet.ts.net', 'https://host.tailnet.ts.net:65536',
    'https://host.tailnet.ts.net/path', 'https://host.tailnet.ts.net\\@example.com',
  ]) {
    assert.equal(privateUploadOrigin(invalid), null, invalid);
  }
});
