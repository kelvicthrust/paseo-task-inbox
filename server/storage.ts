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
}

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
    const { user_version } = database.prepare("PRAGMA user_version").get() as { user_version: number };
    if (user_version > 1) throw new Error("The inbox database needs a newer plugin version.");
    database.exec(`
      PRAGMA busy_timeout = 5000;
      BEGIN IMMEDIATE;
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
      PRAGMA user_version = 1;
      COMMIT;
    `);
  } catch (error) {
    database.close();
    throw error;
  }
  return database;
}

export function readState(database: DatabaseSync, workspaceId: string): WorkspaceState {
  const row = database.prepare("SELECT data FROM workspaces WHERE id = ?").get(workspaceId);
  const state = row ? JSON.parse(row.data as string) as WorkspaceState : { items: [], batch: null, annotations: [] };
  state.annotations ??= [];
  return state;
}

export function editState<T>(
  database: DatabaseSync,
  workspaceId: string,
  edit: (state: WorkspaceState) => T,
): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const state = readState(database, workspaceId);
    const result = edit(state);
    database.prepare(`
      INSERT INTO workspaces (id, data, active) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET data = excluded.data, active = excluded.active
    `).run(workspaceId, JSON.stringify(state), Number(
      state.annotations.length > 0 || (state.batch !== null && state.batch.phase !== "finished"),
    ));
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
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
  return database.prepare(`
    SELECT mime_type, bytes FROM images WHERE workspace_id = ? AND item_id = ? ORDER BY ordinal
  `).all(workspaceId, itemId).map((row) => ({
    data: Buffer.from(row.bytes as Uint8Array).toString("base64"),
    mimeType: row.mime_type as ImageType,
  }));
}

export function insertImage(
  database: DatabaseSync, workspaceId: string, item: Item, mimeType: ImageType, bytes: Buffer,
) {
  database.prepare(`
    INSERT INTO images (workspace_id, item_id, ordinal, mime_type, bytes) VALUES(?, ?, ?, ?, ?)
  `).run(workspaceId, item.id, item.images + 1, mimeType, bytes);
  item.images += 1;
}
