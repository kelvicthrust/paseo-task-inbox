import {
  useRpc,
  useWorkspace,
  type PluginClientContext,
  type PluginWorkspacePanelProps,
  type PluginWorkspaceRowBadgeItemProps,
} from '@getpaseo/plugin/client';
import { WorkspaceRowBadge } from '@getpaseo/plugin/client/ui';
import { statusLabel } from './client/controls.tsx';
import { WorkspaceInbox } from './client/inbox.tsx';
import { BatchOutcome } from './client/outcome.tsx';
import { useInboxQuery } from './client/query.ts';
import { AgentSettings, ScreenshotSettings } from './client/settings.tsx';
import { readInboxBadge } from './shared/rpc.ts';
import { batchOutcomeKind, batchOutcomeSchema, batchOutcomeVersion } from './shared/outcome.ts';

const id = 'inbox';
const title = 'Task Inbox';
const icon = 'Inbox';

function InboxPanel(props: PluginWorkspacePanelProps) {
  const workspaceName = useWorkspace(
    props.workspaceId,
    (workspace) => workspace.title ?? workspace.name,
  );
  return (
    <WorkspaceInbox key={JSON.stringify([props.host.id, props.workspaceId])} workspaceName={workspaceName ?? undefined} {...props} />
  );
}

function InboxRowBadge({ host, workspaceId }: PluginWorkspaceRowBadgeItemProps) {
  const read = useRpc(readInboxBadge);
  const { data } = useInboxQuery(() => read({ workspaceId }), 10_000);
  if (!data?.status || !data.count) return null;
  const tones = { inbox: 'muted', queued: 'info', working: 'info', blocked: 'warning', completed: 'success' } as const;
  const finished = data.status === 'completed';
  return (
    <WorkspaceRowBadge
      key={host.id}
      icon={finished ? 'CircleCheck' : icon}
      label={String(data.count)}
      tone={tones[data.status]}
      accessibilityLabel={finished ? `Task Inbox, ${data.count} completed` : `Task Inbox, ${data.count} open, ${statusLabel[data.status]}`}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  const remove = [
    client.addWorkspacePanel({ id, title, icon, locations: ['explorer'], Component: InboxPanel }),
    client.addWorkspaceRowBadgeItem({
      id,
      title,
      icon,
      Component: (props) => <InboxRowBadge key={JSON.stringify([props.host.id, props.workspaceId])} {...props} />,
    }),
    client.addCommandCenterItem({
      id: 'open-inbox',
      title: 'Open Task Inbox',
      icon,
      context: 'workspace',
      onSelect: ({ openPanel }) => openPanel(id, { location: 'explorer' }),
    }),
    client.addTimelineRenderer({
      kind: batchOutcomeKind,
      version: batchOutcomeVersion,
      schema: batchOutcomeSchema,
      Component: BatchOutcome,
    }),
    client.addSettingsScreen({
      id: 'agent',
      title: 'Task Inbox agent',
      icon: 'Bot',
      Component: (props) => <AgentSettings key={props.host.id} {...props} />,
    }),
    client.addSettingsScreen({
      id: 'screenshots',
      title: 'Screenshot uploads',
      icon: 'ImagePlus',
      Component: (props) => <ScreenshotSettings key={props.host.id} {...props} />,
    }),
  ];
  return () => {
    for (const stop of remove.reverse()) stop();
  };
}
