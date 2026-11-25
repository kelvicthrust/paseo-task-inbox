import assert from 'node:assert/strict';
import test from 'node:test';
import {
  attachmentMimeType,
  loadInboxPreview,
  stageInboxFile,
} from '../client/screenshot-transfer.ts';
import { inboxImageChunkBytes } from '../shared/rpc.ts';
import { screenshotLimit } from '../shared/screenshot.ts';

test('the picker accepts only bounded PNG and JPEG files', () => {
  assert.equal(attachmentMimeType({ name: 'capture.PNG', type: '', size: 20 }), 'image/png');
  assert.equal(attachmentMimeType({ name: 'capture', type: 'image/jpeg', size: 20 }), 'image/jpeg');
  assert.throws(() => attachmentMimeType({ name: 'capture.png', type: 'image/webp', size: 20 }), /PNG or JPEG/);
  assert.throws(() => attachmentMimeType({ name: 'capture.jpg', type: '', size: screenshotLimit + 1 }), /8 MiB/);
  assert.throws(() => attachmentMimeType({ name: 'capture.jpg', type: '', size: 0 }), /empty/);
});

test('an interrupted attachment resumes by offset and keeps the original bytes', async () => {
  const bytes = Uint8Array.from({ length: 2 * inboxImageChunkBytes + 71 }, (_, i) => i % 251);
  const file = new File([bytes], 'capture.png', { type: 'image/png' });
  const received = new Uint8Array(bytes.length);
  const offsets: number[] = [];
  const scope = { workspaceId: 'local', draftId: 'draft', imageId: 'screenshot' };
  let committed = 0;
  let interrupted = false;
  const stage = () => stageInboxFile({
    begin: async (input) => {
      assert.deepEqual(input, { ...scope, mimeType: 'image/png', size: bytes.length });
      return { grant: 'grant', received: committed };
    },
    append: async ({ grant, offset, data }) => {
      assert.equal(grant, 'grant');
      assert.equal(offset, committed);
      const chunk = Buffer.from(data, 'base64');
      assert.ok(chunk.length <= inboxImageChunkBytes);
      offsets.push(offset);
      received.set(chunk, offset);
      committed += chunk.length;
      if (!interrupted) {
        interrupted = true;
        throw new Error('reply lost');
      }
      return { received: committed };
    },
  }, scope, { file, mimeType: 'image/png' }, () => true);

  await assert.rejects(stage, /reply lost/);
  assert.equal(await stage(), 'grant');
  assert.deepEqual(received, bytes);
  assert.deepEqual(offsets, [0, inboxImageChunkBytes, 2 * inboxImageChunkBytes]);
});

test('a discarded attachment stops transferring after an in-flight request', async () => {
  const file = new File([new Uint8Array(inboxImageChunkBytes + 1)], 'capture.png');
  let active = true;
  const result = await stageInboxFile({
    begin: async () => ({ grant: 'grant', received: 0 }),
    append: async ({ offset }) => {
      assert.equal(offset, 0);
      active = false;
      return { received: inboxImageChunkBytes };
    },
  }, { workspaceId: 'local', draftId: 'draft', imageId: 'image' },
  { file, mimeType: 'image/png' }, () => active);
  assert.equal(result, undefined);
});

test('previews reassemble separately encoded chunks and reject incomplete replies', async () => {
  const bytes = Uint8Array.from({ length: inboxImageChunkBytes + 3 }, (_, i) => i % 251);
  const offsets: number[] = [];
  const target = { workspaceId: 'local', itemId: 'task', version: 1, imageId: 'image' };
  const image = { id: 'image', mimeType: 'image/png' as const, size: bytes.length };
  const preview = await loadInboxPreview(async (input) => {
    assert.deepEqual(input, { ...target, offset: input.offset });
    offsets.push(input.offset);
    return { data: Buffer.from(bytes.subarray(input.offset, input.offset + inboxImageChunkBytes)).toString('base64') };
  }, target, image, () => true);
  assert.ok(preview);
  assert.equal(preview.type, 'image/png');
  assert.deepEqual(new Uint8Array(await preview.arrayBuffer()), bytes);
  assert.deepEqual(offsets, [0, inboxImageChunkBytes]);
  await assert.rejects(loadInboxPreview(async () => ({ data: 'YQ==' }), target, image, () => true), /incomplete/);
});
