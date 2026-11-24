import type { PaseoAgent, PaseoWorkspace } from "@getpaseo/client";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { basename } from "node:path";
import { taskInboxProviders } from "../shared/agent.ts";
import { batchOutcomeKind, batchOutcomeVersion } from "../shared/outcome.ts";
import { readOrigin, verifyPullRequest } from "./github.ts";
import type { InboxAgent, InboxHost, InboxWorkspace, TimelineEntry } from "./inbox-types.ts";

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
    resumable: agent.status === "closed" && agent.persistence != null,
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
    async agentModels(workspace) {
      const { providers, error } = await paseo.providers.listAvailable();
      if (error) throw new Error("Paseo could not check provider availability.");
      const models = await Promise.all(Object.entries(taskInboxProviders)
        .filter(([provider]) => providers.some((entry) => entry.provider === provider && entry.available))
        .map(async ([provider, label]) => {
          const result = await paseo.providers.listModels(provider, { cwd: workspace?.directory });
          return (result.models ?? [])
            .filter((model) => model.isSelectable !== false)
            .map((model) => ({ value: `${provider}/${model.id}`, label: `${label} · ${model.label}` }));
        }));
      return models.flat();
    },
    async createAgent(workspace, { agentId, batchId, model }) {
      const agent = await paseo.workspaces.ref(workspace.id).agents.create({
        agentId,
        idempotencyKey: `task-inbox:${batchId}`,
        title: "Task Inbox",
        config: { provider: model },
      });
      if (agent.id !== agentId) throw new Error("Paseo did not confirm the requested chat.");
    },
    repository: readOrigin,
    async timeline(agentId, cursor) {
      const response = await paseo.agents.ref(agentId).timeline.refetch({
        direction: cursor ? "after" : "tail",
        ...(cursor ? { cursor } : {}),
        projection: "canonical",
        limit: cursor ? 100 : 1,
      });
      if (response.error || response.agentId !== agentId || !response.epoch) {
        throw new Error("The selected chat’s timeline is unavailable.");
      }
      const reset = response.reset || response.staleCursor || response.gap;
      const projected = response.projection === "projected";
      let endSeq = response.endCursor?.seq ?? null;
      if (projected && !reset && !response.hasNewer && endSeq !== null &&
          (response.agent?.status === "running" || response.agent?.activeTurn != null)) {
        const growing = response.entries.find(({ item, seqEnd }) =>
          item.type === "assistant_message" && seqEnd === response.window.maxSeq);
        // Paseo 0.16.1 returns full assistant snapshots. Leave a growing row
        // unread until it is superseded or the turn is inactive.
        if (growing) endSeq = Math.min(endSeq, growing.seqStart - 1);
      }
      return {
        epoch: response.epoch,
        firstSeq: response.window.minSeq,
        latestSeq: response.window.maxSeq,
        endSeq,
        hasNewer: response.hasNewer,
        reset,
        entries: response.entries.flatMap(({ item, turnId, seqStart, seqEnd }): TimelineEntry[] => {
          if (endSeq === null || seqStart > endSeq) return [];
          if (item.type === "user_message" || item.type === "assistant_message" || item.type === "plugin") {
            if (seqEnd > endSeq || (cursor && !reset && seqEnd <= cursor.seq)) return [];
            const identity = { seq: seqEnd, turnId };
            if (item.type === "user_message") return [{ ...identity, ...item }];
            if (item.type === "assistant_message") return [{ ...identity, ...item, ...(projected ? { complete: true } : {}) }];
            if (item.pluginId === "task-inbox" && item.kind === batchOutcomeKind && item.version === batchOutcomeVersion) {
              return [{ ...identity, type: "outcome", batchId: item.id }];
            }
          }
          if (cursor && !reset && seqStart <= cursor.seq) return [];
          return [{ seq: seqStart, turnId, type: "other" }];
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
