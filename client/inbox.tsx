import { useRpc, useSettings, type PluginSurfaceProps } from '@getpaseo/plugin/client';
import { ExternalLink, Modal } from '@getpaseo/plugin/client/ui';
import { useCallback, useEffect, useRef, useState, type Ref } from 'react';
import { Pressable, StyleSheet, Text, View, type LayoutChangeEvent, type ScrollView, type TextInput } from 'react-native';
import { taskInboxAgentSettings } from '../shared/agent.ts';
import {
  deleteInboxItem,
  issueUploadLink,
  listInboxAgentModels,
  maxBatchItems,
  maxItemScreenshots,
  readInbox,
  readInboxItem,
  startInboxBatchInNewChat,
  type InboxItemView,
} from '../shared/rpc.ts';
import { Action, Copy, IconAction, Page, VerifiedPr, statusLabel, type Colors } from './controls.tsx';
import { useKeyboardNavigation } from './browser-capture.tsx';
import { TaskEditor, type ReadyInboxItem } from './editor.tsx';
import { errorMessage, useInboxQuery } from './query.ts';

type Operation = 'start' | 'edit' | 'delete' | 'attach';
type FocusTarget = { kind: 'new' | 'edit' } | { kind: 'row'; id: string };

export function WorkspaceInbox({
  host, layout, theme, navigation, workspaceId, workspaceName,
}: PluginSurfaceProps & { workspaceId: string; workspaceName?: string }) {
  const read = useRpc(readInbox);
  const readItem = useRpc(readInboxItem);
  const deleteItem = useRpc(deleteInboxItem);
  const start = useRpc(startInboxBatchInNewChat);
  const issue = useRpc(issueUploadLink);
  const listModels = useRpc(listInboxAgentModels);
  const settings = useSettings(taskInboxAgentSettings);
  const models = useInboxQuery(() => listModels({ workspaceId }), 20_000);
  const { data, error, refresh } = useInboxQuery(() => read({ workspaceId }), 3_000);
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(() => new Set());
  const [busy, setBusy] = useState<Operation>();
  const [startError, setStartError] = useState<string>();
  const [rowError, setRowError] = useState<{ message: string; chatId?: string }>();
  const [menu, setMenu] = useState<{ id: string; anchor: View }>();
  const [editing, setEditing] = useState<ReadyInboxItem>();
  const [deleting, setDeleting] = useState<InboxItemView>();
  const [deleteError, setDeleteError] = useState<string>();
  const [upload, setUpload] = useState<{ url: string; number: number; itemId: string }>();
  const [completedOpen, setCompletedOpen] = useState(false);
  const [focus, setFocus] = useState<FocusTarget>();
  const lock = useRef(false);
  const newInput = useRef<TextInput>(null);
  const editInput = useRef<TextInput>(null);
  const scroll = useRef<ScrollView>(null);
  const rowButtons = useRef(new Map<string, View>());
  const colors = theme.colors;
  const web = layout.platform === 'web';
  const keyboardNavigation = useKeyboardNavigation(web);

  useEffect(() => {
    if (!focus || busy) return;
    setFocus(undefined);
    if (focus.kind === 'edit') {
      scroll.current?.scrollTo({ y: 0, animated: false });
      editInput.current?.focus();
    } else if (focus.kind === 'row') {
      (rowButtons.current.get(focus.id) ?? newInput.current)?.focus();
    } else {
      newInput.current?.focus();
    }
  }, [focus, busy]);

  async function act(kind: Operation, work: () => Promise<void>, report: (message: string | undefined) => void) {
    if (lock.current) return;
    lock.current = true;
    setBusy(kind);
    report(undefined);
    try {
      await work();
    } catch (problem) {
      report(errorMessage(problem));
    } finally {
      await refresh();
      lock.current = false;
      setBusy(undefined);
    }
  }

  if (!data) {
    return (
      <Page theme={theme}>
        <View style={{ gap: 8 }}>
          <Copy colors={colors} error={Boolean(error)}>{error ?? 'Loading Task Inbox…'}</Copy>
          {error && <Action colors={colors} label="Retry" onPress={refresh} />}
        </View>
      </Page>
    );
  }

  const inbox = data.items.filter(({ status }) => status === 'inbox');
  const inFlight = data.items.filter(({ status }) => status !== 'inbox' && status !== 'completed');
  const completed = data.items.filter(({ status }) => status === 'completed');
  const checkedIds = inbox.filter(({ id }) => !excluded.has(id)).map(({ id }) => id);
  const batch = data.batch?.status === 'completed' ? null : data.batch;
  const model = settings.status === 'ready' ? models.data?.find(({ value }) => value === settings.values.model) : undefined;
  const modelHint = model && !models.error ? undefined
    : models.error ? 'Couldn’t check available agent models.'
    : settings.status === 'loading' || !models.data ? 'Checking available agent models…'
    : 'Choose an agent model in Settings → Plugins → Task Inbox agent.';
  const batchAgent = data.agents.find(({ id }) => id === batch?.agentId);
  const canStart = !busy && !error && !editing && !deleting && data.canStart && Boolean(model) && !models.error &&
    checkedIds.length > 0 && checkedIds.length <= maxBatchItems;
  const currentEdit = editing && data.items.find(({ id }) => id === editing.item.id);
  const currentDelete = deleting && data.items.find(({ id }) => id === deleting.id);
  const menuItem = menu && inbox.find(({ id }) => id === menu.id);

  function chatAction(id?: string) {
    if (id && navigation && data?.agents.some((agent) => agent.id === id)) {
      return () => navigation.openAgent({ serverId: host.id, agentId: id });
    }
    return undefined;
  }

  const openBatchChat = chatAction(batch?.agentId);
  const openRowChat = chatAction(rowError?.chatId);

  function toggle(id: string) {
    setMenu(undefined);
    setExcluded((previous) => {
      const next = new Set(previous);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  function closeMenu(id: string) {
    setMenu(undefined);
    (rowButtons.current.get(id) ?? newInput.current)?.focus();
  }

  function toggleMenu(id: string) {
    if (menu?.id === id) return closeMenu(id);
    const anchor = rowButtons.current.get(id);
    if (anchor) setMenu({ id, anchor });
  }

  function openEditor(item: InboxItemView) {
    setMenu(undefined);
    void act('edit', async () => {
      const result = await readItem({ workspaceId, itemId: item.id });
      if (result.status === 'ready') {
        setEditing(result);
        setFocus({ kind: 'edit' });
      } else {
        setRowError(result.status === 'claimed'
          ? { message: `Task #${item.number} has already been sent to chat.`, chatId: result.item.chatId }
          : { message: `Task #${item.number} was deleted.` });
        setFocus({ kind: 'new' });
      }
    }, (message) => {
      setRowError(message ? { message } : undefined);
      if (message) setFocus({ kind: 'row', id: item.id });
    });
  }

  function closeEditor() {
    setEditing(undefined);
    if (editing && currentEdit?.status === 'inbox') setFocus({ kind: 'row', id: editing.item.id });
    else setFocus({ kind: 'new' });
  }

  function confirmDelete(item: InboxItemView) {
    setMenu(undefined);
    setDeleteError(undefined);
    setDeleting(item);
  }

  function closeDelete(id: string) {
    setDeleting(undefined);
    setFocus({ kind: 'row', id });
  }

  function deleteTask(item: InboxItemView) {
    void act('delete', async () => {
      const result = await deleteItem({ workspaceId, itemId: item.id, version: item.version });
      if (result.status === 'deleted' || result.status === 'missing') {
        const index = inbox.findIndex(({ id }) => id === item.id);
        const next = index < 0 ? inbox[0] : (inbox[index + 1] ?? inbox[index - 1]);
        setDeleting(undefined);
        setFocus(next ? { kind: 'row', id: next.id } : { kind: 'new' });
      } else if (result.status === 'stale') {
        setDeleting(result.item);
        setDeleteError('This task changed. Review the current description before deleting.');
      } else {
        setDeleting(result.item);
        setDeleteError('This task has already been sent to chat.');
      }
    }, setDeleteError);
  }

  function attach(item: InboxItemView) {
    setMenu(undefined);
    void act('attach', async () => {
      const link = await issue({ workspaceId, itemId: item.id, allowLoopback: web });
      setUpload({ ...link, number: item.number, itemId: item.id });
    }, (message) => {
      setRowError(message ? { message } : undefined);
      if (message) setFocus({ kind: 'row', id: item.id });
    });
  }

  const batchFooter = (
    <>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
          <Copy colors={colors} heading size={13}>{checkedIds.length} selected</Copy>
          {model && <Copy colors={colors} muted size={12}>{model.label}</Copy>}
        </View>
        <Action
          colors={colors}
          label={busy === 'start' ? 'Starting…' : !data.canStart ? 'Batch active' : checkedIds.length ? `Start ${checkedIds.length} ${checkedIds.length === 1 ? 'task' : 'tasks'}` : 'Start work'}
          icon="Play"
          primary compact={web}
          disabled={!canStart}
          onPress={() => {
            if (!canStart) return;
            void act('start', async () => { await start({ workspaceId, itemIds: checkedIds }); }, setStartError);
          }}
        />
      </View>
      {modelHint && <Copy colors={colors} muted size={12}>{modelHint}</Copy>}
      {checkedIds.length > maxBatchItems && <Copy colors={colors} error size={12}>Select up to {maxBatchItems} tasks for one batch.</Copy>}
      {editing && !batch && <Copy colors={colors} muted size={12}>Close the editor before starting work.</Copy>}
      {startError && <Copy colors={colors} error size={13}>{startError}</Copy>}
    </>
  );

  const taskMenu = menu && menuItem && (
    <TaskMenu
      key={menu.id} anchor={menu.anchor} colors={colors} web={web}
      dismiss={() => closeMenu(menu.id)} edit={() => openEditor(menuItem)} deleteTask={() => confirmDelete(menuItem)}
      attach={!web && menuItem.images < maxItemScreenshots ? () => attach(menuItem) : undefined}
    />
  );

  return (
    <Page theme={theme} footer={batchFooter} overlay={taskMenu} scrollRef={scroll}>
      {workspaceName && <Copy colors={colors} heading size={19}>{workspaceName}</Copy>}
      <View style={editing ? { display: 'none' } : undefined}>
        <TaskEditor
          workspaceId={workspaceId} colors={colors} web={web} disabled={Boolean(busy)} inputRef={newInput}
          keyboardNavigation={keyboardNavigation}
          onSaved={() => { void refresh(); setFocus({ kind: 'new' }); }}
        />
      </View>
      {editing && (
        <TaskEditor
          key={editing.item.id}
          workspaceId={workspaceId} colors={colors} web={web} disabled={Boolean(busy)}
          initial={editing} currentItem={currentEdit ?? (error ? undefined : null)} inputRef={editInput}
          keyboardNavigation={keyboardNavigation}
          onClose={closeEditor}
          onSaved={() => { closeEditor(); void refresh(); }}
          chatAction={chatAction}
        />
      )}
      {error && (
        <View style={{ gap: 5 }}>
          <Copy colors={colors} error>{error}</Copy>
          <Action colors={colors} label="Retry inbox" compact={web} onPress={refresh} />
        </View>
      )}
      {batch && (
        <View style={{ borderRadius: 8, borderWidth: 1, borderColor: colors.border, padding: 10, gap: 4 }}>
          <Copy colors={colors} heading size={14}>Batch · {statusLabel[batch.status]}</Copy>
          {batchAgent && <Copy colors={colors} muted size={12}>{batchAgent.label}</Copy>}
          {batch.detail && <Copy colors={colors} size={13}>{batch.detail}</Copy>}
          {openBatchChat && (
            <Action colors={colors} label="Open chat" icon="MessageSquare" compact={web} onPress={openBatchChat} />
          )}
        </View>
      )}
      <View style={{ gap: 4 }}>
        <Copy colors={colors} heading size={16}>Inbox{inbox.length ? ` · ${inbox.length}` : ''}</Copy>
        {rowError && (
          <View style={{ gap: 3 }}>
            <Copy colors={colors} error size={13}>{rowError.message}</Copy>
            {openRowChat && (
              <Action colors={colors} label="Open chat" icon="MessageSquare" compact={web} onPress={openRowChat} />
            )}
          </View>
        )}
        {inbox.length === 0 && <Copy colors={colors} muted size={13}>No tasks waiting.</Copy>}
        {inbox.map((item) => (
          <InboxRow
            key={item.id}
            item={item}
            colors={colors}
            web={web}
            checked={!excluded.has(item.id)}
            toggle={() => toggle(item.id)}
            expanded={menuItem?.id === item.id}
            toggleMenu={() => toggleMenu(item.id)}
            menuButtonRef={(button) => {
              if (button) rowButtons.current.set(item.id, button);
              else rowButtons.current.delete(item.id);
            }}
            disabled={Boolean(busy || editing || deleting)}
          />
        ))}
      </View>
      {inFlight.length > 0 && (
        <View style={{ gap: 4 }}>
          <Copy colors={colors} heading size={16}>Sent to chat</Copy>
          {inFlight.map((item) => <HistoryRow key={item.id} item={item} colors={colors} batchDetail={batch?.detail} />)}
        </View>
      )}
      {completed.length > 0 && (
        <View style={{ gap: 4 }}>
          <Action
            colors={colors} label={`Completed · ${completed.length}`} icon={completedOpen ? 'ChevronDown' : 'ChevronRight'}
            compact={web} subtle expanded={completedOpen} onPress={() => setCompletedOpen(!completedOpen)}
          />
          {completedOpen && completed.map((item) => <HistoryRow key={item.id} item={item} colors={colors} />)}
        </View>
      )}
      {deleting && (
        <DeleteConfirmation
          colors={colors} web={web} item={deleting} pending={busy === 'delete'} error={deleteError}
          current={currentDelete ?? (error ? undefined : null)}
          onClose={() => closeDelete(deleting.id)} onDelete={() => deleteTask(deleting)}
          chatAction={chatAction}
        />
      )}
      {upload && (
        <Modal title={`Attach screenshot to #${upload.number}`} open onOpenChange={(open) => {
          if (!open) { setUpload(undefined); setFocus({ kind: 'row', id: upload.itemId }); }
        }}>
          <Modal.Content>
            <Copy colors={colors}>Choose a PNG or JPEG in your browser. The link is valid for five minutes and accepts one screenshot.</Copy>
            {upload.url.startsWith('http:') && <Copy colors={colors} muted>Open the link in a browser running on {host.label}.</Copy>}
            <ExternalLink href={upload.url} accessibilityLabel="Open screenshot uploader">
              <View style={{ minHeight: 44, justifyContent: 'center' }}>
                <Text style={{ color: colors.accent, fontWeight: '600' }}>Open screenshot uploader</Text>
              </View>
            </ExternalLink>
          </Modal.Content>
        </Modal>
      )}
    </Page>
  );
}

function InboxRow({
  item, colors, web, checked, toggle, expanded, toggleMenu, menuButtonRef, disabled,
}: {
  item: InboxItemView;
  colors: Colors;
  web: boolean;
  checked: boolean;
  toggle: () => void;
  expanded: boolean;
  toggleMenu: () => void;
  menuButtonRef: Ref<View>;
  disabled: boolean;
}) {
  const row = (
    <View style={{ borderTopColor: colors.border, borderTopWidth: 1, paddingVertical: 5 }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 4 }}>
        <IconAction
          colors={colors} icon={checked ? 'SquareCheck' : 'Square'} label={`Include task #${item.number} in the batch`}
          checked={checked} compact={web} disabled={disabled} onPress={toggle}
        />
        <View style={{ flex: 1, minWidth: 0, gap: 1, paddingVertical: 4 }}>
          <Copy colors={colors}>{item.text}</Copy>
          <TaskMeta item={item} colors={colors} />
        </View>
        <IconAction
          colors={colors} icon="Ellipsis" label={`Actions for task #${item.number}`} expanded={expanded}
          focusRef={menuButtonRef} compact={web} disabled={disabled} onPress={toggleMenu}
        />
      </View>
    </View>
  );
  return web ? (
    <div style={{ minWidth: 0 }} onKeyDown={(event) => {
      if (expanded && event.key === 'Escape') { event.stopPropagation(); toggleMenu(); }
    }}>{row}</div>
  ) : row;
}

function TaskMenu({ anchor, colors, web, dismiss, edit, deleteTask, attach }: {
  anchor: View;
  colors: Colors;
  web: boolean;
  dismiss: () => void;
  edit: () => void;
  deleteTask: () => void;
  attach?: () => void;
}) {
  const layer = useRef<View>(null);
  const firstAction = useRef<View>(null);
  const lastAction = useRef<View>(null);
  const [position, setPosition] = useState<{ top: number; bottom: number; right: number; width: number; height: number }>();
  const [menuHeight, setMenuHeight] = useState<number>();
  const visible = position !== undefined && menuHeight !== undefined;
  const gap = 4;

  function measureAnchor({ nativeEvent: { layout: { width, height } } }: LayoutChangeEvent) {
    // The trigger is inside the scroller. Measure both views in window coordinates.
    layer.current?.measureInWindow((layerX, layerY) => {
      anchor.measureInWindow((x, y, anchorWidth, anchorHeight) => {
        const top = y - layerY;
        const right = Math.max(gap, layerX + width - x - anchorWidth);
        setPosition({ top, bottom: top + anchorHeight, right, width, height });
      });
    });
  }

  useEffect(() => {
    if (visible) firstAction.current?.focus();
  }, [visible]);

  let top = 0;
  if (visible) {
    const below = position.bottom + gap;
    const preferred = below + menuHeight <= position.height ? below : position.top - gap - menuHeight;
    top = Math.max(0, preferred);
  }

  const overlay = (
    <View ref={layer} collapsable={false} onLayout={measureAnchor} style={[StyleSheet.absoluteFill, { zIndex: 1 }]}>
      <Pressable accessible={false} focusable={false} onPress={dismiss} style={StyleSheet.absoluteFill} />
      <View
        onLayout={({ nativeEvent }) => setMenuHeight(nativeEvent.layout.height)}
        pointerEvents={visible ? 'auto' : 'none'}
        accessibilityElementsHidden={!visible}
        importantForAccessibility={visible ? 'auto' : 'no-hide-descendants'}
        style={{
          position: 'absolute', top, right: position?.right ?? gap,
          maxWidth: position ? Math.max(0, position.width - position.right - gap) : '100%',
          opacity: visible ? 1 : 0, backgroundColor: colors.surface1, borderRadius: 7,
          borderColor: colors.border, borderWidth: 1, padding: 3,
        }}
      >
        <Action colors={colors} label="Edit task" icon="Pencil" compact={web} subtle focusRef={firstAction} onPress={edit} />
        {attach && <Action colors={colors} label="Attach screenshot in browser" icon="ImagePlus" compact={web} subtle onPress={attach} />}
        <Action colors={colors} label="Delete task" icon="Trash2" compact={web} subtle danger focusRef={lastAction} onPress={deleteTask} />
      </View>
    </View>
  );
  return web ? (
    <div style={{ display: 'contents' }} onKeyDown={(event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        dismiss();
      } else if (event.key === 'Tab' && Object.is(event.target, (event.shiftKey ? firstAction : lastAction).current)) {
        // Let the browser continue tabbing from the trigger's place in the list.
        dismiss();
      }
    }}>{overlay}</div>
  ) : overlay;
}

function TaskMeta({ item, colors }: { item: InboxItemView; colors: Colors }) {
  return (
    <Copy colors={colors} muted size={12}>
      #{item.number}{item.images > 0 ? ` · ${item.images} ${item.images === 1 ? 'screenshot' : 'screenshots'}` : ''}
    </Copy>
  );
}

function HistoryRow({ item, colors, batchDetail }: { item: InboxItemView; colors: Colors; batchDetail?: string }) {
  return (
    <View style={{ borderTopWidth: 1, borderTopColor: colors.border, paddingVertical: 8, gap: 3 }}>
      <Copy colors={colors}>{item.text}</Copy>
      <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 7 }}>
        <TaskMeta item={item} colors={colors} />
        <Text style={{ color: item.status === 'blocked' ? colors.statusWarning : item.status === 'completed' ? colors.statusSuccess : colors.foregroundMuted, fontSize: 12 }}>
          {statusLabel[item.status]}
        </Text>
      </View>
      {item.detail && item.detail !== batchDetail && <Copy colors={colors} muted size={13}>{item.detail}</Copy>}
      <VerifiedPr colors={colors} url={item.prUrl} />
    </View>
  );
}

function DeleteConfirmation({
  colors, web, item, current, pending, error, onClose, onDelete, chatAction,
}: {
  colors: Colors;
  web: boolean;
  item: InboxItemView;
  current: InboxItemView | null | undefined;
  pending: boolean;
  error: string | undefined;
  onClose: () => void;
  onDelete: () => void;
  chatAction: (id?: string) => (() => void) | undefined;
}) {
  const claimed = current && current.status !== 'inbox' ? current : item.status !== 'inbox' ? item : undefined;
  const unavailable = Boolean(claimed) || current === null;
  const conflict = claimed ? 'This task has already been sent to chat.' : current === null ? 'This task was already deleted.' : error;
  const openChat = chatAction(claimed?.chatId);
  const focusCancel = useCallback((button: View | null) => {
    if (!button) return;
    const frame = requestAnimationFrame(() => button.focus());
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <Modal title={`Delete task #${item.number}?`} open onOpenChange={(open) => !open && !pending && onClose()}>
      <Modal.Content>
        <Copy colors={colors}>{item.text}</Copy>
        {conflict && <Copy colors={colors} error>{conflict}</Copy>}
        {!unavailable && item.images > 0 && (
          <Copy colors={colors} muted>{item.images === 1 ? 'Its screenshot will also be deleted.' : `Its ${item.images} screenshots will also be deleted.`}</Copy>
        )}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          <Action
            colors={colors} label={unavailable ? 'Close' : 'Cancel'} compact={web} onPress={onClose} disabled={pending}
            focusRef={focusCancel}
          />
          {!unavailable && (
            <Action colors={colors} label={pending ? 'Deleting…' : 'Delete task'} compact={web} danger disabled={pending} onPress={onDelete} />
          )}
          {openChat && (
            <Action colors={colors} label="Open chat" compact={web} onPress={() => { onClose(); openChat(); }} />
          )}
        </View>
      </Modal.Content>
    </Modal>
  );
}
