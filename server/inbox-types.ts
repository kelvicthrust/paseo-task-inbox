import type { BatchOutcome } from "../shared/outcome.ts";

export type ImageType = "image/png" | "image/jpeg";
export type ItemStatus = "inbox" | "queued" | "working" | "blocked" | "completed";
export type BatchStatus = Exclude<ItemStatus, "inbox">;

export interface InboxWorkspace {
  id: string;
  label: string;
  directory: string;
}

export interface InboxAgent {
  id: string;
  label: string;
  provider: string;
  workspaceId: string | null;
  status: "idle" | "running" | "initializing" | "error" | "closed";
  activeTurn: string | null;
  pendingPermission: boolean;
}

export interface TimelineCursor {
  epoch: string;
  seq: number;
}

export type TimelineEntry = { seq: number; turnId?: string } & (
  | { type: "user_message"; clientMessageId?: string; text: string }
  | { type: "assistant_message"; messageId?: string; text: string }
  | { type: "outcome"; batchId: string }
  | { type: "other" }
);

export interface TimelinePage {
  epoch: string;
  firstSeq: number;
  latestSeq: number;
  reset: boolean;
  hasNewer: boolean;
  entries: TimelineEntry[];
}

export interface BatchMessage {
  messageId: string;
  text: string;
  images: { data: string; mimeType: ImageType }[];
}

export interface PullRequestClaim {
  url: string;
  revision: string;
  batchId: string;
  itemId: string;
}

export type Verification =
  | { status: "verified"; url: string; revision: string; fixRevision: string }
  | { status: "rejected" | "retry"; detail: string };

export interface InboxHost {
  workspaces(): Promise<InboxWorkspace[]>;
  workspace(id: string): Promise<InboxWorkspace | null>;
  agents(workspaceId: string): Promise<InboxAgent[]>;
  agent(id: string): Promise<InboxAgent | null>;
  repository(workspace: InboxWorkspace): Promise<string | null>;
  timeline(agentId: string, cursor: TimelineCursor | null): Promise<TimelinePage>;
  send(agentId: string, message: BatchMessage): Promise<void>;
  canAnnotate?(): boolean;
  annotate?(agentId: string, outcome: BatchOutcome): Promise<void>;
  verify(input: PullRequestClaim & { workspace: InboxWorkspace; repository: string }): Promise<Verification>;
}
