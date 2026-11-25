import type { RpcOutput } from '@getpaseo/plugin';
import { useRpc } from '@getpaseo/plugin/client';
import { Icon, TextInput } from '@getpaseo/plugin/client/ui';
import { useEffect, useRef, useState, type Ref, type RefObject } from 'react';
import { Image, Text, View, type TextInput as InputHandle } from 'react-native';
import {
  appendInboxImageChunk,
  beginInboxImage,
  discardInboxImages,
  maxItemScreenshots,
  maxItemText,
  readInboxImageChunk,
  readInboxItem,
  saveInboxItem,
  type InboxItemView,
  type SaveInboxItemInput,
} from '../shared/rpc.ts';
import { BrowserFileCapture } from './browser-capture.tsx';
import { Action, Copy, IconAction, statusLabel, type Colors } from './controls.tsx';
import { errorMessage } from './query.ts';
import {
  attachmentMimeType,
  loadInboxPreview,
  stageInboxFile,
  type InputScreenshot,
  type StoredScreenshot,
} from './screenshot-transfer.ts';

export type ReadyInboxItem = Extract<RpcOutput<typeof readInboxItem>, { status: 'ready' }>;
type ItemConflict = Extract<RpcOutput<typeof saveInboxItem>, { status: 'stale' | 'claimed' | 'missing' }>;
type ExistingScreenshot = StoredScreenshot & { kind: 'existing' };
type NewScreenshot = InputScreenshot & { id: string; kind: 'new' } & (
  | { status: 'uploading' }
  | { status: 'failed'; error: string }
  | { status: 'staged'; grant: string }
);
type DraftScreenshot = ExistingScreenshot | NewScreenshot;

function createDraftId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}-${Math.random()}`;
}

function toExisting(image: StoredScreenshot): ExistingScreenshot {
  return { ...image, kind: 'existing' };
}

export function TaskEditor({
  workspaceId, colors, web, disabled, initial, currentItem, inputRef, keyboardNavigation, onClose, onSaved, chatAction,
}: {
  workspaceId: string;
  colors: Colors;
  web: boolean;
  disabled: boolean;
  initial?: ReadyInboxItem;
  currentItem?: InboxItemView | null;
  inputRef: Ref<InputHandle>;
  keyboardNavigation: RefObject<boolean>;
  onClose?: () => void;
  onSaved: () => void;
  chatAction?: (id?: string) => (() => void) | undefined;
}) {
  const begin = useRpc(beginInboxImage);
  const append = useRpc(appendInboxImageChunk);
  const discard = useRpc(discardInboxImages);
  const saveItem = useRpc(saveInboxItem);
  const readItem = useRpc(readInboxItem);
  const [draftId, setDraftId] = useState(createDraftId);
  const [source, setSource] = useState(initial);
  const [text, setText] = useState(initial?.item.text ?? '');
  const textRef = useRef(text);
  const [images, setImages] = useState<DraftScreenshot[]>(() => initial?.images.map(toExisting) ?? []);
  const imagesRef = useRef(images);
  const [attempt, setAttempt] = useState<SaveInboxItemInput>();
  const attemptRef = useRef<SaveInboxItemInput>(undefined);
  const [saving, setSaving] = useState(false);
  const [showFocus, setShowFocus] = useState(false);
  const [rejected, setRejected] = useState<string>();
  const [error, setError] = useState<string>();
  const [conflict, setConflict] = useState<ItemConflict>();
  const [latest, setLatest] = useState<ReadyInboxItem>();
  const [loadingLatest, setLoadingLatest] = useState(false);
  const live = useRef(true);
  const saveLock = useRef(false);
  const latestLock = useRef(false);
  const discardRef = useRef(discard);
  discardRef.current = discard;

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      if (imagesRef.current.some(({ kind }) => kind === 'new')) {
        void discardRef.current({ workspaceId, draftId }).catch(() => {});
      }
    };
  }, [workspaceId, draftId]);

  const observedConflict = !source || attempt ? undefined
    : currentItem === null ? { status: 'missing' as const }
    : currentItem && currentItem.status !== 'inbox' ? { status: 'claimed' as const, item: currentItem }
    : currentItem && currentItem.version > source.item.version ? { status: 'stale' as const, item: currentItem }
    : undefined;
  const problem = conflict && conflict.status !== 'stale' ? conflict : observedConflict ?? conflict;
  const openChat = problem?.status === 'claimed' ? chatAction?.(problem.item.chatId) : undefined;
  const readOnly = disabled || Boolean(attempt || problem);
  const ready = images.every((image) => image.kind === 'existing' || image.status === 'staged');
  const canSave = !disabled && !saving && !problem && (
    Boolean(attempt) || (Boolean(text.trim()) && ready && !rejected && images.length <= maxItemScreenshots)
  );

  function replaceImages(next: DraftScreenshot[]) {
    imagesRef.current = next;
    setImages(next);
  }

  function updateImage(id: string, image: DraftScreenshot) {
    replaceImages(imagesRef.current.map((current) => current.id === id ? image : current));
  }

  async function stage(image: NewScreenshot) {
    const active = () => live.current && imagesRef.current.some(({ id }) => id === image.id);
    const scope = { workspaceId, draftId, imageId: image.id };
    updateImage(image.id, { ...image, status: 'uploading' });
    try {
      const grant = await stageInboxFile({ begin, append }, scope, image, active);
      if (grant) updateImage(image.id, { ...image, status: 'staged', grant });
    } catch (failure) {
      if (active()) updateImage(image.id, { ...image, status: 'failed', error: errorMessage(failure) });
    } finally {
      // A removal can overlap the server's first acknowledgement.
      if (!active()) void discard(scope).catch(() => {});
    }
  }

  function retryUpload(image: NewScreenshot) {
    if (!readOnly && !saveLock.current && imagesRef.current.some((current) =>
      current.id === image.id && current.kind === 'new' && current.status === 'failed')) {
      void stage(image);
    }
  }

  function addFiles(files: File[]) {
    if (readOnly || saveLock.current) return;
    const accepted: NewScreenshot[] = [];
    let rejection: string | undefined;
    for (const file of files) {
      if (imagesRef.current.length + accepted.length >= maxItemScreenshots) {
        rejection ??= `Choose up to ${maxItemScreenshots} screenshots per task.`;
        break;
      }
      try {
        accepted.push({
          kind: 'new', id: createDraftId(), file, mimeType: attachmentMimeType(file), status: 'uploading',
        });
      } catch (failure) {
        rejection ??= `${file.name || 'Screenshot'} · ${errorMessage(failure)}`;
      }
    }
    if (rejection) setRejected(rejection);
    replaceImages([...imagesRef.current, ...accepted]);
    for (const image of accepted) void stage(image);
  }

  function remove(image: DraftScreenshot) {
    if (readOnly || saveLock.current) return;
    replaceImages(imagesRef.current.filter(({ id }) => id !== image.id));
    if (image.kind === 'new') {
      void discard({ workspaceId, draftId, imageId: image.id }).catch(() => {});
    }
  }

  async function save() {
    if (!canSave || saveLock.current) return;
    const description = textRef.current.trim();
    if (!attemptRef.current && (!description || imagesRef.current.some((image) => image.kind === 'new' && image.status !== 'staged'))) return;
    const input: SaveInboxItemInput = attemptRef.current ?? {
      workspaceId,
      draftId,
      operationId: createDraftId(),
      text: description,
      ...(source && { target: { itemId: source.item.id, version: source.item.version } }),
      images: imagesRef.current.map((image) => {
        if (image.kind === 'existing') return { kind: 'existing', imageId: image.id };
        if (image.status !== 'staged') throw new Error('Wait for screenshots to finish uploading.');
        return { kind: 'staged', imageId: image.id, grant: image.grant };
      }),
    };
    saveLock.current = true;
    attemptRef.current = input;
    setSaving(true);
    setAttempt(input);
    setError(undefined);
    try {
      const result = await saveItem(input);
      if (!live.current) return;
      attemptRef.current = undefined;
      setAttempt(undefined);
      if (result.status === 'saved') {
        replaceImages([]);
        textRef.current = '';
        setText('');
        setDraftId(createDraftId());
        onSaved();
      } else if (result.status === 'upload-expired') {
        const image = imagesRef.current.find(({ id }) => id === result.imageId);
        if (image?.kind === 'new') {
          updateImage(image.id, { ...image, status: 'failed', error: 'Upload expired. Retry this screenshot.' });
        }
      } else {
        setConflict(result);
      }
    } catch (failure) {
      if (live.current) setError(`Couldn’t confirm the save. Retry to recover it. ${errorMessage(failure)}`);
    } finally {
      saveLock.current = false;
      if (live.current) setSaving(false);
    }
  }

  async function reviewLatest() {
    if (!source || latestLock.current) return;
    latestLock.current = true;
    setLoadingLatest(true);
    setError(undefined);
    try {
      const newest = await readItem({ workspaceId, itemId: source.item.id });
      if (!live.current) return;
      if (newest.status === 'ready') setLatest(newest);
      else setConflict(newest);
    } catch (failure) {
      if (live.current) setError(errorMessage(failure));
    } finally {
      latestLock.current = false;
      if (live.current) setLoadingLatest(false);
    }
  }

  function keepEdits() {
    if (!source || !latest) return;
    const removed = new Set(source.images.filter(({ id }) => !imagesRef.current.some((image) => image.id === id)).map(({ id }) => id));
    const newImages = imagesRef.current.filter(({ kind }) => kind === 'new');
    replaceImages([...latest.images.filter(({ id }) => !removed.has(id)).map(toExisting), ...newImages]);
    setSource(latest);
    setLatest(undefined);
    setConflict(undefined);
  }

  function composer(choose?: () => void) {
    return (
      <View style={{
        backgroundColor: colors.surface1,
        borderColor: showFocus ? colors.accent : colors.border,
        borderRadius: 10, borderWidth: 1, padding: 10, gap: 6,
      }}>
        <Copy colors={colors} heading size={14}>{source ? `Editing task #${source.item.number}` : 'New task'}</Copy>
        <TextInput
          ref={inputRef}
          accessibilityLabel="Bug description"
          placeholder="What went wrong?"
          placeholderTextColor={colors.foregroundMuted}
          selectionColor={colors.accent}
          editable={!readOnly}
          onFocus={() => setShowFocus(!web || keyboardNavigation.current)}
          onBlur={() => setShowFocus(false)}
          multiline
          maxLength={maxItemText}
          value={text}
          onChangeText={(value) => {
            textRef.current = value;
            setText(value);
          }}
          style={{
            minHeight: 76, paddingHorizontal: 0, paddingVertical: 4, color: colors.foreground,
            fontSize: 14, lineHeight: 20, textAlignVertical: 'top',
            ...(web && { outlineWidth: 0 }),
          }}
        />
        {images.map((image, index) => {
          const label = image.kind === 'existing' ? `Screenshot ${index + 1}` : image.file.name || `Screenshot ${index + 1}`;
          const failed = image.kind === 'new' && image.status === 'failed';
          return (
            <View key={image.id} style={{ paddingHorizontal: 5, paddingVertical: 3, gap: 2, borderRadius: 7, backgroundColor: colors.surface2 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
                {web && image.kind === 'new' ? <Thumbnail colors={colors} label={label} file={image.file} />
                  : web && source && image.kind === 'existing' ? (
                    <ExistingThumbnail
                      key={source.item.version}
                      colors={colors}
                      label={label}
                      workspaceId={workspaceId}
                      target={source.item}
                      image={image}
                    />
                  ) : <Thumbnail colors={colors} label={label} />}
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: 13 }}>{label}</Text>
                  {image.kind === 'new' && image.status === 'uploading' && <Copy colors={colors} muted size={12}>Uploading…</Copy>}
                </View>
                <IconAction colors={colors} icon="X" label={`Remove ${label}`} compact={web} disabled={readOnly} onPress={() => remove(image)} />
              </View>
              {failed && (
                <View style={{ paddingHorizontal: 4 }}>
                  <Copy colors={colors} error size={12}>{image.error}</Copy>
                  <Action colors={colors} label="Retry upload" accessibilityLabel={`Retry upload for ${label}`} subtle compact={web} disabled={readOnly} onPress={() => retryUpload(image)} />
                </View>
              )}
            </View>
          );
        })}
        {rejected && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <View style={{ flex: 1, minWidth: 0 }}><Copy colors={colors} error size={12}>{rejected}</Copy></View>
            <IconAction colors={colors} icon="X" label="Dismiss rejected attachment" compact={web} onPress={() => setRejected(undefined)} disabled={readOnly} />
          </View>
        )}
        {images.length > maxItemScreenshots && <Copy colors={colors} error size={12}>Remove screenshots to keep up to {maxItemScreenshots}.</Copy>}
        {error && <Copy colors={colors} error size={13}>{error}</Copy>}
        {problem?.status === 'stale' && (
          <View style={{ gap: 5 }}>
            <Copy colors={colors} error size={13}>Task #{problem.item.number} changed. Review the latest version before saving.</Copy>
            {latest?.item && latest.item.version >= problem.item.version ? (
              <View style={{ gap: 5, padding: 8, backgroundColor: colors.surface2, borderRadius: 6 }}>
                <Copy colors={colors} heading size={13}>Latest saved description</Copy>
                <Copy colors={colors} size={13}>{latest.item.text}</Copy>
                <Copy colors={colors} muted size={12}>{latest.images.length} screenshots</Copy>
                <Action colors={colors} label="Keep my edits" compact={web} onPress={keepEdits} />
              </View>
            ) : <Action colors={colors} label={loadingLatest ? 'Loading…' : 'Review latest'} compact={web} disabled={loadingLatest} onPress={() => void reviewLatest()} />}
          </View>
        )}
        {problem?.status === 'claimed' && (
          <View style={{ gap: 5 }}>
            <Copy colors={colors} error size={13}>Task #{problem.item.number} is {statusLabel[problem.item.status].toLowerCase()} in chat. Your edit is still here.</Copy>
            {openChat && <Action colors={colors} label="Open chat" icon="MessageSquare" compact={web} onPress={openChat} />}
          </View>
        )}
        {problem?.status === 'missing' && <Copy colors={colors} error size={13}>This task was deleted. Your edit is still here.</Copy>}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 4 }}>
          {choose && !problem && (
            <Action
              colors={colors}
              label="Attach"
              accessibilityLabel="Choose screenshots"
              icon="Paperclip"
              subtle compact={web}
              disabled={readOnly || images.length >= maxItemScreenshots}
              onPress={choose}
            />
          )}
          <View style={{
            marginLeft: problem ? undefined : 'auto', maxWidth: '100%', flexDirection: 'row',
            alignItems: 'center', justifyContent: 'flex-end', flexWrap: 'wrap', gap: 4,
          }}>
            {onClose && (
              <Action
                colors={colors}
                label={problem ? 'Close editor' : 'Cancel'}
                subtle compact={web}
                disabled={saving}
                onPress={onClose}
              />
            )}
            {!problem && (
              <Action
                colors={colors}
                label={saving ? 'Saving…' : attempt ? 'Retry save' : source ? 'Save changes' : 'Add task'}
                primary compact={web}
                disabled={!canSave}
                onPress={() => void save()}
              />
            )}
          </View>
        </View>
        {web && !problem && images.length < maxItemScreenshots && (
          <Copy colors={colors} muted size={12}>Paste or drop a PNG or JPEG.</Copy>
        )}
        {!web && !source && <Copy colors={colors} muted size={12}>Add a task to attach a screenshot from its actions.</Copy>}
      </View>
    );
  }

  return web ? (
    <BrowserFileCapture disabled={readOnly} onFiles={addFiles} onPointerInput={() => setShowFocus(false)}>
      {composer}
    </BrowserFileCapture>
  ) : composer();
}

function Thumbnail({
  colors, label, file,
}: {
  colors: Colors;
  label: string;
  file?: Blob;
}) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!file) return;
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);
  return (
    <View style={{ width: 42, height: 34, justifyContent: 'center', alignItems: 'center', borderRadius: 4, backgroundColor: colors.surface1, overflow: 'hidden' }}>
      {url ? <Image source={{ uri: url }} accessibilityLabel={`${label} preview`} resizeMode="contain" style={{ width: '100%', height: '100%' }} />
        : <Icon name="Image" color={colors.foregroundMuted} size={16} />}
    </View>
  );
}

function ExistingThumbnail({
  colors, label, workspaceId, target, image,
}: {
  colors: Colors;
  label: string;
  workspaceId: string;
  target: InboxItemView;
  image: ExistingScreenshot;
}) {
  const read = useRpc(readInboxImageChunk);
  const readRef = useRef(read);
  readRef.current = read;
  const { id: itemId, version } = target;
  const { id, mimeType, size } = image;
  const [file, setFile] = useState<Blob>();
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let active = true;
    void loadInboxPreview(readRef.current, { workspaceId, itemId, version, imageId: id }, { id, mimeType, size }, () => active)
      .then((preview) => { if (active) setFile(preview); })
      .catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [workspaceId, itemId, version, id, mimeType, size, retry]);

  return failed ? (
    <IconAction colors={colors} icon="RotateCw" compact label={`Retry ${label} preview`} onPress={() => { setFailed(false); setRetry((previous) => previous + 1); }} />
  ) : <Thumbnail colors={colors} label={label} file={file} />;
}
