import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  inboxImageChunkBytes, maxItemScreenshots, maxItemText, type InboxItemView, type SaveInboxItemInput,
} from "../shared/rpc.ts";
import { screenshotLimit } from "../shared/screenshot.ts";
import { createImageStaging } from "./image-staging.ts";
import type { ImageType } from "./inbox-types.ts";
import {
  editState, insertImage, insertSaveReceipt, readImageChunk, readImageMetadata, readSaveReceipt,
  readSnapshot, readState, readStoredImages, removeImages,
  type Batch, type Item, type StoredImage, type WorkspaceState,
} from "./storage.ts";

type ItemTarget = { workspaceId: string; itemId: string };
type ImageStaging = ReturnType<typeof createImageStaging>;

export function itemView(item: Item, batch: Batch | null): InboxItemView {
  const { id, number, text, status, detail, images, prUrl } = item;
  const chatId = item.chatId ?? (batch?.itemIds.includes(id) ? batch.agentId : undefined);
  return {
    id, number, text, status, detail, images, version: item.version ?? 1,
    ...(prUrl ? { prUrl } : {}),
    ...(status !== "inbox" && chatId ? { chatId } : {}),
  };
}

function editableItem(state: WorkspaceState, itemId: string) {
  const item = state.items.find(({ id }) => id === itemId);
  if (!item) return { status: "missing" } as const;
  if (item.status !== "inbox") return { status: "claimed", item: itemView(item, state.batch) } as const;
  return { status: "ready", item } as const;
}

function versionedItem(state: WorkspaceState, itemId: string, version: number) {
  const result = editableItem(state, itemId);
  if (result.status === "ready" && (result.item.version ?? 1) !== version) {
    return { status: "stale", item: itemView(result.item, state.batch) } as const;
  }
  return result;
}

function cleanText(text: string) {
  const cleaned = text.trim();
  if (!cleaned || cleaned.length > maxItemText) throw new Error("Enter between 1 and 8,000 characters.");
  return cleaned;
}

function newItem(state: WorkspaceState, text: string): Item {
  const item: Item = {
    id: randomUUID(), number: state.nextItemNumber++, version: 1, text, status: "inbox", detail: "", images: 0,
  };
  state.items.push(item);
  return item;
}

function hasLegacySignature(mimeType: ImageType, bytes: Buffer) {
  if (mimeType === "image/png") {
    return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  }
  return mimeType === "image/jpeg" && bytes.length >= 5 &&
    bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes.at(-2) === 255 && bytes.at(-1) === 217;
}

export function createCapture(
  database: DatabaseSync, getWorkspace: (workspaceId: string) => Promise<unknown>, staging: ImageStaging,
) {
  return {
    async add(workspaceId: string, text: string) {
      const cleaned = cleanText(text);
      await getWorkspace(workspaceId);
      editState(database, workspaceId, (state) => { newItem(state, cleaned); });
    },
    async attach(workspaceId: string, itemId: string, mimeType: ImageType, bytes: Buffer) {
      if (bytes.length > screenshotLimit || !hasLegacySignature(mimeType, bytes)) {
        throw new Error("Choose a PNG or JPEG image up to 8 MiB.");
      }
      await getWorkspace(workspaceId);
      editState(database, workspaceId, (state) => {
        const result = editableItem(state, itemId);
        if (result.status !== "ready") throw new Error("Images can only be added to bugs in this workspace inbox.");
        const { item } = result;
        if (item.images >= maxItemScreenshots) throw new Error("A bug can have up to four images.");
        insertImage(database, workspaceId, item, { id: randomUUID(), mimeType, bytes });
        item.version = (item.version ?? 1) + 1;
      });
    },
    async beginImage(input: Parameters<ImageStaging["begin"]>[0]) {
      await getWorkspace(input.workspaceId);
      return staging.begin(input);
    },
    async appendImageChunk(input: Parameters<ImageStaging["append"]>[0]) {
      await getWorkspace(input.workspaceId);
      return staging.append(input);
    },
    async discardImages(input: Parameters<ImageStaging["discard"]>[0]) {
      await getWorkspace(input.workspaceId);
      staging.discard(input);
      return {};
    },
    async readItem({ workspaceId, itemId }: ItemTarget) {
      await getWorkspace(workspaceId);
      return readSnapshot(database, () => {
        const state = readState(database, workspaceId);
        const result = editableItem(state, itemId);
        if (result.status !== "ready") return result;
        return {
          status: "ready" as const,
          item: itemView(result.item, state.batch),
          images: readImageMetadata(database, workspaceId, itemId),
        };
      });
    },
    async readImageChunk({ workspaceId, itemId, version, imageId, offset }: ItemTarget & {
      version: number; imageId: string; offset: number;
    }) {
      await getWorkspace(workspaceId);
      return readSnapshot(database, () => {
        const result = versionedItem(readState(database, workspaceId), itemId, version);
        if (result.status !== "ready") throw new Error("This task changed. Review the latest saved version.");
        const bytes = readImageChunk(database, workspaceId, itemId, imageId, offset, inboxImageChunkBytes);
        if (!bytes?.length) throw new Error("The screenshot is unavailable.");
        return { data: Buffer.from(bytes).toString("base64") };
      });
    },
    async saveItem({ workspaceId, draftId, operationId, text, target, images }: SaveInboxItemInput) {
      const cleaned = cleanText(text);
      const references = images.map(({ kind, imageId }) => [kind, imageId]);
      const distinct = new Set(references.map(([kind, id]) => `${kind}:${id}`));
      if (images.length > maxItemScreenshots || images.length !== distinct.size) {
        throw new Error("Choose up to four distinct screenshots.");
      }
      // Grants may be renewed after a disconnect. The operation describes the
      // ordered draft images, independent of the tokens used to transfer them.
      const requestHash = createHash("sha256").update(JSON.stringify([
        draftId, cleaned, target ? [target.itemId, target.version] : null, references,
      ])).digest("hex");
      await getWorkspace(workspaceId);
      const result = editState(database, workspaceId, (state) => {
        const receipt = readSaveReceipt(database, workspaceId, operationId);
        if (receipt) {
          if (receipt.requestHash !== requestHash) throw new Error("This save ID was already used for a different task change.");
          const { itemId: id, number, version } = receipt;
          // The matching request supplies the text, so deleted task content is
          // absent from durable receipts.
          return {
            status: "saved" as const,
            item: itemView({ id, number, version, text: cleaned, status: "inbox", detail: "", images: images.length }, null),
          };
        }

        const current = target && versionedItem(state, target.itemId, target.version);
        if (current && current.status !== "ready") return current;
        const existing = images.some(({ kind }) => kind === "existing") && current
          ? readStoredImages(database, workspaceId, current.item.id)
          : [];
        const ordered: StoredImage[] = [];
        for (const reference of images) {
          const { imageId } = reference;
          if (reference.kind === "existing") {
            const image = existing.find(({ id }) => id === imageId);
            if (!image) throw new Error("A saved screenshot is unavailable. Review the latest task.");
            ordered.push(image);
          } else {
            const stage = staging.complete({ workspaceId, draftId, imageId, grant: reference.grant });
            if (!stage) return { status: "upload-expired" as const, imageId };
            ordered.push({ id: randomUUID(), bytes: stage.bytes, mimeType: stage.mimeType });
          }
        }

        const item = current ? current.item : newItem(state, cleaned);
        if (current) {
          item.text = cleaned;
          item.version = (item.version ?? 1) + 1;
          removeImages(database, workspaceId, item.id);
          item.images = 0;
        }
        for (const image of ordered) insertImage(database, workspaceId, item, image);
        const view = itemView(item, state.batch);
        insertSaveReceipt(database, workspaceId, operationId, {
          requestHash, itemId: item.id, number: item.number, version: view.version,
        });
        return { status: "saved" as const, item: view };
      });
      if (result.status === "saved") {
        for (const image of images) {
          if (image.kind === "staged") staging.consume({ workspaceId, draftId, imageId: image.imageId, grant: image.grant });
        }
      }
      return result;
    },
    async deleteItem({ workspaceId, itemId, version }: ItemTarget & { version: number }) {
      await getWorkspace(workspaceId);
      return editState(database, workspaceId, (state) => {
        const result = versionedItem(state, itemId, version);
        if (result.status !== "ready") return result;
        removeImages(database, workspaceId, itemId);
        state.items = state.items.filter(({ id }) => id !== itemId);
        return { status: "deleted" } as const;
      });
    },
  };
}
