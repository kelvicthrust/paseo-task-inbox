import {
  useRpc,
  useWorkspace,
  type PluginClientContext,
  type PluginScreenProps,
  type PluginSidebarItemProps,
  type PluginWorkspacePanelProps,
  type PluginWorkspaceRowBadgeItemProps,
} from '@getpaseo/plugin/client';
import { SettingsCard, SettingsSelect, SidebarRow, WorkspaceRowBadge } from '@getpaseo/plugin/client/ui';
import { useState } from 'react';
import { Action, Copy, Page, statusLabel } from './client/controls.tsx';
import { WorkspaceInbox } from './client/inbox.tsx';
import { BatchOutcome } from './client/outcome.tsx';
import { useInboxQuery } from './client/query.ts';
import { ScreenshotSettings } from './client/settings.tsx';
import { listWorkspaces, readInboxBadge } from './shared/rpc.ts';
import { batchOutcomeKind, batchOutcomeSchema, batchOutcomeVersion } from './shared/outcome.ts';

const id = 'inbox';
const title = 'Task Inbox';
const icon = 'Inbox';

function SidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return <SidebarRow icon={icon} active={currentScreen?.screenId === id} onPress={() => openScreen({ screenId: id })} />;
}

function InboxScreen(props: PluginScreenProps) {
  const workspaces = useRpc(listWorkspaces);
  const { data, error, refresh } = useInboxQuery(() => workspaces({}), 15_000);
  const [chosenId, setChosenId] = useState(props.params.workspaceId);
  const selected = data?.find(({ id }) => id === chosenId) ?? data?.[0];
  const colors = props.theme.colors;

  return (
    <Page {...props}>
      {error && <Copy colors={colors} error>{error}</Copy>}
      {error && <Action colors={colors} label="Retry" onPress={refresh} />}
      {!data && !error && <Copy colors={colors} muted>Loading workspaces…</Copy>}
      {data?.length === 0 && <Copy colors={colors} muted>Open a workspace on {props.host.label} to capture bugs.</Copy>}
      {selected && (
        <>
          <SettingsCard>
            <SettingsSelect
              label="Workspace"
              value={selected.id}
              onValueChange={setChosenId}
              options={data!.map(({ id, label }) => ({ value: id, label }))}
            />
          </SettingsCard>
          <WorkspaceInbox key={selected.id} {...props} workspaceId={selected.id} />
        </>
      )}
    </Page>
  );
}

function InboxPanel(props: PluginWorkspacePanelProps) {
  const workspaceName = useWorkspace(
    props.workspaceId,
    (workspace) => workspace.title ?? workspace.name,
  );
  return (
    <Page {...props}>
      {workspaceName && <Copy colors={props.theme.colors} heading size={20}>{workspaceName}</Copy>}
      <WorkspaceInbox key={JSON.stringify([props.host.id, props.workspaceId])} {...props} />
    </Page>
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
    client.addSidebarHeaderItem({ id, title, Component: SidebarItem }),
    client.addScreen({
      id,
      title,
      Component: (props) => <InboxScreen key={JSON.stringify([props.host.id, props.params.workspaceId])} {...props} />,
    }),
    client.addWorkspacePanel({ id, title, icon, locations: ['workspace'], Component: InboxPanel }),
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
      onSelect: ({ openPanel }) => openPanel(id, { location: 'workspace' }),
    }),
    client.addTimelineRenderer({
      kind: batchOutcomeKind,
      version: batchOutcomeVersion,
      schema: batchOutcomeSchema,
      Component: BatchOutcome,
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
