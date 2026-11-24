import { useRpc, useSettings, type PluginSurfaceProps } from '@getpaseo/plugin/client';
import { ExternalLink, Icon, Modal, TextInput } from '@getpaseo/plugin/client/ui';
import { useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { taskInboxAgentSettings } from '../shared/agent.ts';
import {
  addInboxItem,
  issueUploadLink,
  listInboxAgentModels,
  maxBatchItems,
  maxItemScreenshots,
  maxItemText,
  readInbox,
  startInboxBatchInNewChat,
  type InboxItemView,
} from '../shared/rpc.ts';
import { Action, Copy, VerifiedPr, statusLabel, type Colors } from './controls.tsx';
import { errorMessage, useInboxQuery } from './query.ts';

export function WorkspaceInbox({
  host, layout, theme, navigation, workspaceId,
}: PluginSurfaceProps & { workspaceId: string }) {
  const read = useRpc(readInbox);
  const add = useRpc(addInboxItem);
  const start = useRpc(startInboxBatchInNewChat);
  const issue = useRpc(issueUploadLink);
  const listModels = useRpc(listInboxAgentModels);
  const settings = useSettings(taskInboxAgentSettings);
  const models = useInboxQuery(() => listModels({ workspaceId }), 20_000);
  const { data, error, refresh } = useInboxQuery(() => read({ workspaceId }), 3_000);
  const [draft, setDraft] = useState('');
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState<'add' | 'start' | 'attach'>();
  const [message, setMessage] = useState<string>();
  const [upload, setUpload] = useState<{ url: string; number: number }>();
  const lock = useRef(false);
  const colors = theme.colors;

  async function act(kind: NonNullable<typeof busy>, work: () => Promise<void>) {
    if (lock.current || error) return;
    lock.current = true;
    setBusy(kind);
    setMessage(undefined);
    try {
      await work();
      await refresh();
    } catch (problem) {
      setMessage(errorMessage(problem));
      await refresh();
    } finally {
      lock.current = false;
      setBusy(undefined);
    }
  }

  if (!data) {
    return (
      <View style={{ gap: 8 }}>
        <Copy colors={colors} error={Boolean(error)}>{error ?? 'Loading Task Inbox…'}</Copy>
        {error && <Action colors={colors} label="Retry" onPress={refresh} />}
      </View>
    );
  }

  const inbox = data.items.filter(({ status }) => status === 'inbox');
  const inFlight = data.items.filter(({ status }) => status !== 'inbox' && status !== 'completed');
  const completed = data.items.filter(({ status }) => status === 'completed');
  const checked = inbox.filter(({ id }) => !excluded.has(id));
  const checkedIds = checked.map(({ id }) => id);
  const batch = data.batch?.status === 'completed' ? null : data.batch;
  const model = settings.status === 'ready'
    ? models.data?.find(({ value }) => value === settings.values.model)
    : undefined;
  const destinationHint = model && !models.error ? `New Task Inbox chat · ${model.label}`
    : settings.status === 'loading' || (!models.data && !models.error) ? 'Checking available agent models…'
    : 'Choose an available Codex or Claude Code model under Settings → Plugins → Task Inbox.';
  const batchAgent = data.agents.find(({ id }) => id === batch?.agentId);
  const disabled = Boolean(busy || error);
  const submitAllowed = !disabled && data.canStart && Boolean(model) && !models.error &&
    checkedIds.length > 0 && checkedIds.length <= maxBatchItems;

  function toggle(id: string) {
    setExcluded((previous) => {
      const next = new Set(previous);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  function attach(item: InboxItemView) {
    void act('attach', async () => {
      // A web client may use loopback only where no private address has been configured.
      const link = await issue({ workspaceId, itemId: item.id, allowLoopback: layout.platform === 'web' });
      setUpload({ ...link, number: item.number });
    });
  }

  return (
    <>
      <View style={{ gap: 10 }}>
        <Copy colors={colors} heading size={17}>Capture a bug</Copy>
        <TextInput
          accessibilityLabel="Bug description"
          placeholder="What went wrong?"
          placeholderTextColor={colors.foregroundMuted}
          editable={!disabled}
          multiline
          maxLength={maxItemText}
          value={draft}
          onChangeText={setDraft}
          style={{
            minHeight: 96,
            borderColor: colors.border,
            borderWidth: 1,
            backgroundColor: colors.surface1,
            borderRadius: 9,
            padding: 12,
            color: colors.foreground,
            fontSize: 15,
            textAlignVertical: 'top',
          }}
        />
        <Action
          colors={colors}
          label={busy === 'add' ? 'Adding…' : 'Add to inbox'}
          icon="Plus"
          disabled={disabled || !draft.trim()}
          onPress={() => void act('add', async () => {
            await add({ workspaceId, text: draft.trim() });
            setDraft('');
          })}
        />
        {(message || error) && <Copy colors={colors} error>{message ?? error}</Copy>}
        {error && <Action colors={colors} label="Retry" onPress={refresh} />}
      </View>

      {batch && (
        <View style={{ borderColor: colors.border, backgroundColor: colors.surface1, borderWidth: 1, borderRadius: 10, padding: 14, gap: 8 }}>
          <Copy colors={colors} heading size={17}>{statusLabel[batch.status]}</Copy>
          {batchAgent && <Copy colors={colors} muted>{batchAgent.label}</Copy>}
          {batch.detail && <Copy colors={colors}>{batch.detail}</Copy>}
          {navigation && batchAgent && (
            <Action
              colors={colors}
              label="Open chat"
              icon="MessageSquare"
              onPress={() => navigation.openAgent({ serverId: host.id, agentId: batch.agentId })}
            />
          )}
        </View>
      )}

      <View style={{ gap: 10 }}>
        <Copy colors={colors} heading size={17}>Inbox{inbox.length ? ` · ${inbox.length}` : ''}</Copy>
        {inbox.length === 0 && <Copy colors={colors} muted>No captured bugs waiting.</Copy>}
        {inbox.map((item) => (
          <Item
            key={item.id}
            item={item}
            colors={colors}
            checked={!excluded.has(item.id)}
            toggle={disabled ? undefined : () => toggle(item.id)}
            attach={() => attach(item)}
            disabled={disabled}
          />
        ))}
        {inbox.length > 0 && (
          <>
            <Copy colors={colors} muted>{destinationHint}</Copy>
            {checkedIds.length > maxBatchItems && (
              <Copy colors={colors} error>Select up to {maxBatchItems} bugs for one batch.</Copy>
            )}
            {!data.canStart && <Copy colors={colors} muted>New bugs can be added while the current batch runs.</Copy>}
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <Action
                colors={colors}
                label={busy === 'start' ? 'Starting…' : 'Start work'}
                icon="Play"
                primary
                disabled={!submitAllowed}
                onPress={() => {
                  if (!submitAllowed) return;
                  void act('start', () => start({ workspaceId, itemIds: checkedIds }).then(() => undefined));
                }}
              />
              <Copy colors={colors} muted>{checkedIds.length} selected</Copy>
            </View>
          </>
        )}
      </View>

      {inFlight.length > 0 && (
        <View style={{ gap: 10 }}>
          <Copy colors={colors} heading size={17}>Sent to chat</Copy>
          {inFlight.map((item) => <Item key={item.id} item={item} colors={colors} batchDetail={batch?.detail} />)}
        </View>
      )}

      <View style={{ gap: 10 }}>
        <Copy colors={colors} heading size={17}>Completed{completed.length ? ` · ${completed.length}` : ''}</Copy>
        {completed.length === 0 && <Copy colors={colors} muted>No verified fixes yet.</Copy>}
        {completed.map((item) => <Item key={item.id} item={item} colors={colors} />)}
      </View>

      {upload && (
        <Modal title={`Attach screenshot to #${upload.number}`} open onOpenChange={(open) => !open && setUpload(undefined)}>
          <Modal.Content>
            <Copy colors={colors}>Choose a PNG or JPEG in your browser. This link is valid for five minutes and accepts one screenshot.</Copy>
            {upload.url.startsWith('http:') && (
              <Copy colors={colors} muted>Open this link in a browser running on {host.label}.</Copy>
            )}
            <ExternalLink href={upload.url} accessibilityLabel="Open screenshot uploader">
              <View style={{ minHeight: 44, justifyContent: 'center' }}>
                <Text style={{ color: colors.accent, fontWeight: '600' }}>Open screenshot uploader</Text>
              </View>
            </ExternalLink>
          </Modal.Content>
        </Modal>
      )}
    </>
  );
}

function Item({
  item, colors, checked, toggle, attach, disabled, batchDetail,
}: {
  item: InboxItemView;
  colors: Colors;
  checked?: boolean;
  toggle?: () => void;
  attach?: () => void;
  disabled?: boolean;
  batchDetail?: string | undefined;
}) {
  const showStatus = item.status !== 'inbox';
  const tone = item.status === 'blocked' ? colors.statusWarning : colors.foregroundMuted;
  return (
    <View style={{ borderColor: colors.border, borderWidth: 1, borderRadius: 9, padding: 12, gap: 6, backgroundColor: colors.surface1 }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
        {checked !== undefined && (
          <Pressable
            accessibilityRole="checkbox"
            accessibilityLabel={`Include bug ${item.number} in the batch`}
            accessibilityState={{ checked, disabled: !toggle }}
            onPress={toggle}
            disabled={!toggle}
            style={{ width: 44, height: 44, justifyContent: 'center', alignItems: 'center', marginLeft: -8, marginTop: -8 }}
          >
            <Icon name={checked ? 'SquareCheck' : 'Square'} color={checked ? colors.accent : colors.foregroundMuted} size={20} />
          </Pressable>
        )}
        <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            <Copy colors={colors} heading>#{item.number}</Copy>
            {showStatus && <Text style={{ color: tone, fontSize: 13 }}>{statusLabel[item.status]}</Text>}
          </View>
          <Copy colors={colors}>{item.text}</Copy>
          {item.detail !== '' && item.detail !== batchDetail && <Copy colors={colors} muted>{item.detail}</Copy>}
          {item.images > 0 && (
            <Copy colors={colors} muted>{item.images} {item.images === 1 ? 'screenshot' : 'screenshots'}</Copy>
          )}
          <VerifiedPr colors={colors} url={item.prUrl} />
          {attach && item.images < maxItemScreenshots && (
            <Action colors={colors} label="Attach screenshot" icon="ImagePlus" onPress={attach} disabled={Boolean(disabled)} />
          )}
        </View>
      </View>
    </View>
  );
}
