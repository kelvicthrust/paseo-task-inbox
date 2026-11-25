import { randomBytes } from "node:crypto";
import { inboxImageChunkBytes, maxItemScreenshots } from "../shared/rpc.ts";
import { screenshotGrantMs, screenshotLimit } from "../shared/screenshot.ts";
import { isScreenshot, type ScreenshotType } from "./image.ts";

const maxGrants = 64;
const maxStagedBytes = 64 * 1024 * 1024;
const maxEncodedChunk = 4 * Math.ceil(inboxImageChunkBytes / 3);

type DraftScope = { workspaceId: string; draftId: string };
type ImageScope = DraftScope & { imageId: string };
type Upload = ImageScope & { grant: string };
type Staged = Upload & {
  mimeType: ScreenshotType;
  bytes: Buffer;
  expiresAt: number;
  received: number;
};

function sameDraft(a: DraftScope, b: DraftScope) {
  return a.workspaceId === b.workspaceId && a.draftId === b.draftId;
}

export function createImageStaging(now: () => number) {
  const grants = new Map<string, Staged>();

  function expire(time = now()) {
    for (const [token, stage] of grants) {
      if (time >= stage.expiresAt) grants.delete(token);
    }
  }

  function find(scope: Upload) {
    expire();
    const stage = grants.get(scope.grant);
    if (stage && sameDraft(scope, stage) && stage.imageId === scope.imageId) return stage;
  }

  return {
    begin(scope: ImageScope & { mimeType: ScreenshotType; size: number }) {
      const { workspaceId, draftId, imageId, mimeType, size } = scope;
      if ((mimeType !== "image/png" && mimeType !== "image/jpeg") ||
        !Number.isInteger(size) || size < 1 || size > screenshotLimit) {
        throw new Error("Choose a PNG or JPEG image up to 8 MiB.");
      }
      const time = now();
      expire(time);
      const stages = [...grants.values()];
      const draftStages = stages.filter((stage) => sameDraft(scope, stage));
      const current = draftStages.find((stage) => stage.imageId === imageId);
      if (current) {
        if (current.bytes.length !== size || current.mimeType !== mimeType) {
          throw new Error("The screenshot changed. Remove it and add it again.");
        }
        return { grant: current.grant, received: current.received };
      }
      if (draftStages.length >= maxItemScreenshots) throw new Error("A task can have up to four screenshots.");
      if (grants.size >= maxGrants || size + stages.reduce((total, stage) => total + stage.bytes.length, 0) > maxStagedBytes) {
        throw new Error("The host is staging too many screenshots. Retry after other uploads finish.");
      }
      const grant = randomBytes(32).toString("base64url");
      grants.set(grant, {
        workspaceId, draftId, imageId, grant, mimeType, bytes: Buffer.alloc(size),
        expiresAt: time + screenshotGrantMs, received: 0,
      });
      return { grant, received: 0 };
    },
    append(scope: Upload & { offset: number; data: string }) {
      const stage = find(scope);
      if (!stage) throw new Error("This screenshot upload expired. Retry the screenshot.");
      const { offset, data } = scope;
      if (data.length > maxEncodedChunk) throw new Error("The screenshot chunk is too large.");
      const bytes = Buffer.from(data, "base64");
      if (bytes.length < 1 || bytes.length > inboxImageChunkBytes || bytes.toString("base64") !== data) {
        throw new Error("The screenshot chunk is invalid.");
      }
      if (!Number.isInteger(offset) || offset < 0 || offset > stage.received) {
        throw new Error("The screenshot chunks arrived out of order. Retry the screenshot.");
      }
      const end = offset + bytes.length;
      if (end > stage.bytes.length) throw new Error("The screenshot exceeds its declared size.");
      if (offset < stage.received) {
        if (end > stage.received || !bytes.equals(stage.bytes.subarray(offset, end))) {
          throw new Error("The repeated screenshot chunk does not match. Retry the screenshot.");
        }
        return { received: stage.received };
      }
      bytes.copy(stage.bytes, offset);
      if (end === stage.bytes.length && !isScreenshot(stage.bytes, stage.mimeType)) {
        grants.delete(stage.grant);
        throw new Error("The file must be a PNG or JPEG screenshot.");
      }
      stage.received = end;
      return { received: end };
    },
    complete(scope: Upload) {
      const stage = find(scope);
      if (stage && stage.received === stage.bytes.length) return stage;
    },
    discard(scope: DraftScope & { imageId?: string }) {
      expire();
      for (const [token, stage] of grants) {
        if (sameDraft(scope, stage) && (scope.imageId === undefined || scope.imageId === stage.imageId)) {
          grants.delete(token);
        }
      }
    },
    consume(scope: Upload) {
      if (find(scope)) grants.delete(scope.grant);
    },
    expire,
    clear: () => grants.clear(),
  };
}
