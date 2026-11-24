import { screenshotLimit } from '../shared/screenshot.ts';

export function uploadPage(nonce: string): string {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Attach screenshot · Task Inbox</title>
<style nonce="${nonce}">
  :root { color-scheme: light dark; font: 16px/1.5 system-ui, sans-serif; }
  body { margin: 0; padding: 40px 20px; }
  main { max-width: 420px; margin: auto; }
  h1 { font-size: 1.55rem; line-height: 1.25; }
  form { display: grid; gap: 12px; }
  form[hidden] { display: none; }
  input, button { font: inherit; max-width: 100%; }
  button { min-height: 44px; padding: 6px 16px; width: fit-content; }
  input::file-selector-button { min-height: 44px; font: inherit; }
</style>
<main>
  <h1>Attach screenshot</h1>
  <p>Choose a PNG or JPEG up to ${screenshotLimit / 1024 / 1024} MB to attach to your inbox item.</p>
  <form>
    <label for="image">Screenshot</label>
    <input id="image" type="file" accept="image/png,image/jpeg" required disabled>
    <button type="submit" disabled>Attach screenshot</button>
  </form>
  <p role="status" aria-live="polite"></p>
  <noscript>Enable JavaScript to attach a screenshot.</noscript>
</main>
<script nonce="${nonce}">
  const form = document.querySelector('form');
  const input = document.querySelector('input');
  const button = document.querySelector('button');
  const status = document.querySelector('[role=status]');
  let activeGrant = null;

  function openGrant() {
    const token = location.hash.slice(1);
    if (location.hash) history.replaceState(null, '', location.pathname);
    activeGrant = /^[A-Za-z0-9_-]{43}$/.test(token) ? { token } : null;
    input.value = '';
    form.hidden = false;
    input.disabled = !activeGrant;
    button.disabled = !activeGrant;
    status.textContent = activeGrant ? '' : 'Open a fresh screenshot link from Task Inbox.';
  }

  window.addEventListener('hashchange', (event) => {
    if (event.newURL === location.href) openGrant();
  });
  openGrant();

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const grant = activeGrant;
    if (!grant || button.disabled) return;
    const file = input.files[0];
    if (!file || !['image/png', 'image/jpeg'].includes(file.type) || file.size > ${screenshotLimit}) {
      status.textContent = 'Choose a PNG or JPEG up to ${screenshotLimit / 1024 / 1024} MB.';
      return;
    }
    input.disabled = true;
    button.disabled = true;
    status.textContent = 'Attaching…';
    let retryable = true;
    try {
      const response = await fetch(location.pathname, {
        method: 'POST',
        credentials: 'omit',
        redirect: 'error',
        headers: { Authorization: 'Bearer ' + grant.token, 'Content-Type': file.type },
        body: file,
      });
      const message = response.ok ? 'Screenshot attached. Return to Task Inbox.' : await response.text();
      if (activeGrant !== grant) return;
      retryable = [400, 413, 415].includes(response.status);
      form.hidden = response.ok;
      status.textContent = message;
    } catch {
      if (activeGrant === grant) {
        status.textContent = 'Connection interrupted. Check Task Inbox before requesting a fresh link.';
      }
    } finally {
      if (activeGrant === grant && retryable) {
        input.disabled = false;
        button.disabled = false;
      }
    }
  });
</script>
</html>`;
}
