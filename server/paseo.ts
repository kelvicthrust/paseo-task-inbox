import type { PaseoAgent, PaseoWorkspace } from "@getpaseo/client";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { basename } from "node:path";
import { batchOutcomeKind, batchOutcomeVersion } from "../shared/outcome.ts";
import { readOrigin, verifyPullRequest } from "./github.ts";
import type { InboxAgent, InboxHost, InboxWorkspace } from "./inbox-types.ts";

function visibleWorkspace(workspace: PaseoWorkspace): InboxWorkspace | null {
  if (workspace.internal || workspace.background || workspace.archivingAt) return null;
  return {
    id: workspace.id,
    label: workspace.title ?? (workspace.projectCustomName || workspace.projectDisplayName)
      + (workspace.name === workspace.projectDisplayName ? "" : ` / ${workspace.name}`),
    directory: workspace.workspaceDirectory,
  };
}

function visibleAgent(agent: PaseoAgent): InboxAgent | null {
  if (agent.internal || agent.background || agent.archivedAt || agent.providerUnavailable) return null;
  return {
    id: agent.id,
    label: agent.title || `${agent.provider} · ${basename(agent.cwd)} · ${agent.id.slice(0, 8)}`,
    provider: agent.provider,
    workspaceId: agent.workspaceId ?? null,
    status: agent.status,
    activeTurn: agent.activeTurn?.turnId ?? null,
    pendingPermission: agent.pendingPermissions.length > 0 || agent.attentionReason === "permission",
  };
}

type Paseo = PluginHandlerContext["paseo"];

export function createPaseoHost(paseo: Paseo, getPluginApi: () => Paseo | undefined): InboxHost {
  return {
    async workspaces() {
      const workspaces: InboxWorkspace[] = [];
      let cursor: string | undefined;
      do {
        const page = await paseo.workspaces.list({ page: { limit: 100, cursor } });
        for (const entry of page.entries) {
          const workspace = visibleWorkspace(entry);
          if (workspace) workspaces.push(workspace);
        }
        cursor = page.pageInfo.hasMore ? page.pageInfo.nextCursor ?? undefined : undefined;
      } while (cursor);
      return workspaces;
    },
    async workspace(id) {
      const workspace = await paseo.workspaces.ref(id).refresh();
      return workspace?.id === id ? visibleWorkspace(workspace) : null;
    },
    async agents(workspaceId) {
      const agents: InboxAgent[] = [];
      let cursor: string | undefined;
      do {
        const page = await paseo.agents.list({ page: { limit: 100, cursor } });
        for (const { agent } of page.entries) {
          if (agent.workspaceId !== workspaceId) continue;
          const visible = visibleAgent(agent);
          if (visible) agents.push(visible);
        }
        cursor = page.pageInfo.hasMore ? page.pageInfo.nextCursor ?? undefined : undefined;
      } while (cursor);
      return agents;
    },
    async agent(id) {
      const agent = (await paseo.agents.ref(id).refresh())?.agent;
      return agent?.id === id ? visibleAgent(agent) : null;
    },
    repository: readOrigin,
    async timeline(agentId, cursor) {
      const response = await paseo.agents.ref(agentId).timeline.refetch({
        direction: cursor ? "after" : "tail",
        ...(cursor ? { cursor } : {}),
        projection: "canonical",
        limit: cursor ? 100 : 1,
      });
      if (response.error || response.agentId !== agentId || !response.epoch ||
          response.projection !== "canonical") {
        throw new Error("The selected chat’s canonical timeline is unavailable.");
      }
      return {
        epoch: response.epoch,
        firstSeq: response.window.minSeq,
        latestSeq: response.window.maxSeq,
        hasNewer: response.hasNewer,
        reset: response.reset || response.staleCursor || response.gap,
        entries: response.entries.map(({ item, turnId, seqEnd }) => {
          const identity = { seq: seqEnd, turnId };
          if (item.type === "user_message" || item.type === "assistant_message") return { ...identity, ...item };
          if (item.type === "plugin" && item.pluginId === "task-inbox" && item.kind === batchOutcomeKind &&
              item.version === batchOutcomeVersion) {
            return { ...identity, type: "outcome", batchId: item.id };
          }
          return { ...identity, type: "other" };
        }),
      };
    },
    send(agentId, { text, messageId, images }) {
      // The SDK has no conditional idle-only send. The inbox refreshes the chat
      // immediately before calling this method, then requests the steer behavior.
      return paseo.agents.ref(agentId).send(text, { activeTurnBehavior: "steer", messageId, images });
    },
    canAnnotate: () => getPluginApi() !== undefined,
    async annotate(agentId, outcome) {
      const api = getPluginApi();
      if (!api) throw new Error("The Paseo plugin context is unavailable.");
      await api.agents.ref(agentId).timeline.append({
        type: "plugin", id: outcome.batchId, kind: batchOutcomeKind, version: batchOutcomeVersion, data: outcome,
      });
    },
    verify: verifyPullRequest,
  };
}
