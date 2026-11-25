import { open, lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { BatchOutcome } from "../shared/outcome.ts";
import type { BatchStatus, ImageType, ItemStatus, PullRequestClaim, TimelineCursor } from "./inbox-types.ts";

export interface Candidate extends PullRequestClaim {
  detail: string;
  attempts: number;
  retryAt: number;
}

export interface Item {
  id: string;
  number: number;
  version?: number;
  chatId?: string;
  text: string;
  status: ItemStatus;
  detail: string;
  images: number;
  prUrl?: string;
  revision?: string;
  fixRevision?: string;
  candidate?: Candidate;
}

export interface Batch {
  id: string;
  agentId: string;
  itemIds: string[];
  repository: string;
  directory: string;
  messageId: string;
  text: string;
  newChat?: { model: string; attempts: number; attemptedAt: number };
  phase: "queued" | "delivering" | "sent" | "finished";
  status: BatchStatus;
  detail: string;
  attempts: number;
  attemptedAt: number;
  cursor: TimelineCursor | null;
  turnId: string | null;
  historyChanged?: boolean;
  interrupted: boolean;
  idleSince: number | null;
  assistant: { messageId?: string; line: string; overflow: boolean } | null;
}

export interface Annotation {
  agentId: string;
  directory: string;
  outcome: BatchOutcome;
  attempt: { at: number; cursor: TimelineCursor } | null;
}

export interface WorkspaceState {
  items: Item[];
  batch: Batch | null;
  annotations: Annotation[];
  nextItemNumber: number;
}

export interface StoredImage {
  id: string;
  mimeType: ImageType;
  bytes: Uint8Array;
}

interface SaveReceipt {
  requestHash: string;
  itemId: string;
  number: number;
  version: number;
}

const imageId = "coalesce(image_id, 'legacy-' || ordinal)";

export async function openStorage(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryStat = await lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.mode & 0o077) {
    throw new Error("The inbox data directory must be private.");
  }
  const path = join(directory, "inbox.sqlite3");
  try {
    const file = await open(path, "wx", 0o600);
    await file.close();
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
  const dbStat = await lstat(path);
  if (!dbStat.isFile() || dbStat.mode & 0o077) {
    throw new Error("The inbox database must be a private file.");
  }
  const database = new DatabaseSync(path);
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    database.exec("BEGIN IMMEDIATE");
    const { user_version } = database.prepare("PRAGMA user_version").get() as { user_version: number };
    if (user_version > 2) throw new Error("The inbox database needs a newer plugin version.");
    database.exec(`
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        active INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS images (
        workspace_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        mime_type TEXT NOT NULL,
        bytes BLOB NOT NULL,
        PRIMARY KEY (workspace_id, item_id, ordinal)
      ) STRICT;
    `);
    if (user_version < 2) {
      database.exec(`
        ALTER TABLE images ADD COLUMN image_id TEXT;
        CREATE TABLE save_receipts (
          workspace_id TEXT NOT NULL,
          operation_id TEXT NOT NULL,
          request_hash TEXT NOT NULL,
          item_id TEXT NOT NULL,
          number INTEGER NOT NULL,
          version INTEGER NOT NULL,
          PRIMARY KEY (workspace_id, operation_id)
        ) STRICT;
        PRAGMA user_version = 2;
      `);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.close();
    throw error;
  }
  return database;
}

export function readState(database: DatabaseSync, workspaceId: string): WorkspaceState {
  const row = database.prepare("SELECT data FROM workspaces WHERE id = ?").get(workspaceId);
  const state = row ? JSON.parse(row.data as string) as WorkspaceState : {
    items: [], batch: null, annotations: [], nextItemNumber: 1,
  };
  state.annotations ??= [];
  state.nextItemNumber ??= state.items.reduce((next, item) => Math.max(next, item.number + 1), 1);
  return state;
}

export function readSnapshot<T>(database: DatabaseSync, read: () => T): T {
  return transaction(database, "BEGIN", read);
}

function transaction<T>(database: DatabaseSync, begin: "BEGIN" | "BEGIN IMMEDIATE", run: () => T): T {
  database.exec(begin);
  try {
    const result = run();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function editState<T>(
  database: DatabaseSync,
  workspaceId: string,
  edit: (state: WorkspaceState) => T,
): T {
  return transaction(database, "BEGIN IMMEDIATE", () => {
    const state = readState(database, workspaceId);
    const result = edit(state);
    database.prepare(`
      INSERT INTO workspaces (id, data, active) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET data = excluded.data, active = excluded.active
    `).run(workspaceId, JSON.stringify(state), Number(
      state.annotations.length > 0 || (state.batch !== null && state.batch.phase !== "finished"),
    ));
    return result;
  });
}

export function activeWorkspaces(database: DatabaseSync): string[] {
  return database.prepare("SELECT id FROM workspaces WHERE active = 1").all()
    .map(({ id }) => id as string);
}

export function imageSize(database: DatabaseSync, workspaceId: string, itemId: string): number {
  const row = database.prepare(`
    SELECT coalesce(sum(length(bytes)), 0) AS total FROM images WHERE workspace_id = ? AND item_id = ?
  `).get(workspaceId, itemId);
  return row?.total as number;
}

export function readImages(database: DatabaseSync, workspaceId: string, itemId: string) {
  return readStoredImages(database, workspaceId, itemId).map(({ bytes, mimeType }) => ({
    data: Buffer.from(bytes).toString("base64"),
    mimeType,
  }));
}

export function readStoredImages(database: DatabaseSync, workspaceId: string, itemId: string): StoredImage[] {
  return database.prepare(`
    SELECT ${imageId} AS id, mime_type, bytes
    FROM images WHERE workspace_id = ? AND item_id = ? ORDER BY ordinal
  `).all(workspaceId, itemId).map((row) => ({
    id: row.id as string,
    mimeType: row.mime_type as ImageType,
    bytes: row.bytes as Uint8Array,
  }));
}

export function readImageMetadata(database: DatabaseSync, workspaceId: string, itemId: string) {
  return database.prepare(`
    SELECT ${imageId} AS id, mime_type, length(bytes) AS size
    FROM images WHERE workspace_id = ? AND item_id = ? ORDER BY ordinal
  `).all(workspaceId, itemId).map((row) => ({
    id: row.id as string,
    mimeType: row.mime_type as ImageType,
    size: row.size as number,
  }));
}

export function readImageChunk(
  database: DatabaseSync, workspaceId: string, itemId: string, id: string, offset: number, length: number,
): Uint8Array | undefined {
  const row = database.prepare(`
    SELECT substr(bytes, ?, ?) AS bytes FROM images
    WHERE workspace_id = ? AND item_id = ? AND ${imageId} = ? AND length(bytes) > ?
  `).get(offset + 1, length, workspaceId, itemId, id, offset);
  return row?.bytes as Uint8Array | undefined;
}

export function removeImages(database: DatabaseSync, workspaceId: string, itemId: string) {
  database.prepare("DELETE FROM images WHERE workspace_id = ? AND item_id = ?").run(workspaceId, itemId);
}

export function insertImage(database: DatabaseSync, workspaceId: string, item: Item, image: StoredImage) {
  database.prepare(`
    INSERT INTO images (workspace_id, item_id, ordinal, mime_type, bytes, image_id) VALUES(?, ?, ?, ?, ?, ?)
  `).run(workspaceId, item.id, item.images + 1, image.mimeType, image.bytes, image.id);
  item.images += 1;
}

export function readSaveReceipt(database: DatabaseSync, workspaceId: string, operationId: string) {
  return database.prepare(`
    SELECT request_hash AS requestHash, item_id AS itemId, number, version
    FROM save_receipts WHERE workspace_id = ? AND operation_id = ?
  `).get(workspaceId, operationId) as SaveReceipt | undefined;
}

export function insertSaveReceipt(database: DatabaseSync, workspaceId: string, operationId: string, receipt: SaveReceipt) {
  database.prepare(`
    INSERT INTO save_receipts (workspace_id, operation_id, request_hash, item_id, number, version)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(workspaceId, operationId, receipt.requestHash, receipt.itemId, receipt.number, receipt.version);
}
