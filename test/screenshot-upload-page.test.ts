import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { uploadPage } from '../server/upload-page.ts';

const first = 'A'.repeat(43);
const second = 'B'.repeat(43);

function picker(grant: string, fetch: (path: string, request: { headers: Record<string, string> }) => Promise<Response>) {
  const button = { disabled: true };
  const status = { textContent: '' };
  const input = {
    disabled: true,
    files: [] as { type: string; size: number }[],
    set value(value: string) {
      assert.equal(value, '');
      this.files = [];
    },
  };
  let submit: (() => Promise<void>) | undefined;
  let hashChange: ((event: { newURL: string }) => void) | undefined;
  const form = {
    hidden: false,
    addEventListener(event: string, callback: (event: { preventDefault(): void }) => Promise<void>) {
      assert.equal(event, 'submit');
      submit = () => callback({ preventDefault() {} });
    },
  };
  const elements = { form, input, button, '[role=status]': status };
  const location = new URL('http://127.0.0.1/task-inbox/screenshot#' + grant);
  const script = uploadPage('test-nonce').match(/<script nonce="test-nonce">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  runInNewContext(script, {
    document: { querySelector: (selector: keyof typeof elements) => elements[selector] },
    window: {
      addEventListener(event: string, callback: (event: { newURL: string }) => void) {
        assert.equal(event, 'hashchange');
        hashChange = callback;
      },
    },
    location,
    history: { replaceState(_state: unknown, _title: string, path: string) { location.href = new URL(path, location).href; } },
    fetch,
  });

  return {
    button, status, input, form, location,
    navigate(next: string) {
      location.hash = next;
      hashChange?.({ newURL: location.href });
    },
    submit() {
      assert.ok(submit);
      input.files = [{ type: 'image/png', size: 100 }];
      return submit();
    },
  };
}

test('a second screenshot grant opens a fresh picker in the same document', async () => {
  const authorized: string[] = [];
  const page = picker(first, async (_path, request) => {
    authorized.push(request.headers.Authorization);
    return new Response(null, { status: 204 });
  });
  assert.equal(page.location.hash, '');
  await page.submit();
  assert.equal(page.form.hidden, true);
  assert.match(page.status.textContent, /Screenshot attached/);

  page.navigate(second);
  assert.equal(page.location.hash, '');
  assert.equal(page.form.hidden, false);
  assert.equal(page.input.disabled, false);
  assert.equal(page.button.disabled, false);
  assert.deepEqual(page.input.files, []);
  assert.equal(page.status.textContent, '');
  await page.submit();
  assert.deepEqual(authorized, ['Bearer ' + first, 'Bearer ' + second]);
});

test('an older upload finishing during a new grant leaves the newer picker alone', async () => {
  let finishOld!: (response: Response) => void;
  const oldResponse = new Promise<Response>((resolve) => { finishOld = resolve; });
  const page = picker(first, async (_path, request) => request.headers.Authorization === 'Bearer ' + first
    ? oldResponse
    : new Response(null, { status: 204 }));
  const oldSubmit = page.submit();
  assert.equal(page.button.disabled, true);
  page.navigate(second);

  finishOld(new Response(null, { status: 204 }));
  await oldSubmit;

  assert.equal(page.form.hidden, false);
  assert.equal(page.button.disabled, false);
  assert.equal(page.status.textContent, '');
  await page.submit();
  assert.match(page.status.textContent, /Screenshot attached/);
});
