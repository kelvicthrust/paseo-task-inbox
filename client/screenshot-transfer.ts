import type { PluginRpcContract, RpcInput, RpcOutput } from '@getpaseo/plugin';
import {
  inboxImageChunkBytes,
  type appendInboxImageChunk,
  type beginInboxImage,
  type readInboxImageChunk,
} from '../shared/rpc.ts';
import { screenshotLimit } from '../shared/screenshot.ts';

export type ScreenshotMimeType = RpcInput<typeof beginInboxImage>['mimeType'];
export type InputScreenshot = { file: File; mimeType: ScreenshotMimeType };
export type StoredScreenshot = { id: string; mimeType: ScreenshotMimeType; size: number };
type Invoke<Contract extends PluginRpcContract> =
  (input: RpcInput<Contract>) => Promise<RpcOutput<Contract>>;

export type ScreenshotUpload = {
  begin: Invoke<typeof beginInboxImage>;
  append: Invoke<typeof appendInboxImageChunk>;
};
export type ReadScreenshot = Invoke<typeof readInboxImageChunk>;

export function attachmentMimeType(file: Pick<File, 'name' | 'type' | 'size'>): ScreenshotMimeType {
  if (file.size === 0) throw new Error('This file is empty.');
  if (file.size > screenshotLimit) throw new Error('Choose a screenshot up to 8 MiB.');
  if (file.type === 'image/png' || (!file.type && /\.png$/i.test(file.name))) return 'image/png';
  if (file.type === 'image/jpeg' || (!file.type && /\.jpe?g$/i.test(file.name))) return 'image/jpeg';
  throw new Error('Choose a PNG or JPEG screenshot.');
}

function encodeChunk(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 16_384) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 16_384));
  }
  return btoa(binary);
}

export async function stageInboxFile(
  upload: ScreenshotUpload,
  scope: Pick<RpcInput<typeof beginInboxImage>, 'workspaceId' | 'draftId' | 'imageId'>,
  { file, mimeType }: InputScreenshot,
  active: () => boolean,
): Promise<string | undefined> {
  const { grant, received } = await upload.begin({ ...scope, mimeType, size: file.size });
  if (received > file.size) throw new Error('The screenshot upload could not resume.');
  for (let offset = received; offset < file.size;) {
    if (!active()) return undefined;
    const end = Math.min(offset + inboxImageChunkBytes, file.size);
    const bytes = new Uint8Array(await file.slice(offset, end).arrayBuffer());
    if (!active()) return undefined;
    const reply = await upload.append({ ...scope, grant, offset, data: encodeChunk(bytes) });
    if (reply.received !== end) throw new Error('The screenshot upload could not resume.');
    offset = end;
  }
  return active() ? grant : undefined;
}

export async function loadInboxPreview(
  read: ReadScreenshot,
  scope: Omit<RpcInput<typeof readInboxImageChunk>, 'offset'>,
  image: StoredScreenshot,
  active: () => boolean,
): Promise<Blob | undefined> {
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  for (let offset = 0; offset < image.size; offset += inboxImageChunkBytes) {
    if (!active()) return undefined;
    const { data } = await read({ ...scope, offset });
    const bytes = Uint8Array.from(atob(data), (character) => character.charCodeAt(0));
    if (bytes.length !== Math.min(inboxImageChunkBytes, image.size - offset)) {
      throw new Error('The screenshot preview is incomplete.');
    }
    chunks.push(bytes);
  }
  return active() ? new Blob(chunks, { type: image.mimeType }) : undefined;
}
