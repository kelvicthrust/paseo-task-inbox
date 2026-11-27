import { useRpc, useSettings, type PluginSurfaceProps } from '@getpaseo/plugin/client';
import { SettingsAction, SettingsCard, SettingsInput, SettingsRow, SettingsSection, SettingsSelect } from '@getpaseo/plugin/client/ui';
import { useEffect, useState } from 'react';
import { taskInboxAgentSettings } from '../shared/agent.ts';
import { listInboxAgentModels } from '../shared/rpc.ts';
import { privateUploadOrigin, screenshotSettings } from '../shared/screenshot.ts';
import { useInboxQuery } from './query.ts';

export function AgentSettings({ host }: PluginSurfaceProps) {
  const settings = useSettings(taskInboxAgentSettings);
  const list = useRpc(listInboxAgentModels);
  const { data, error, refresh } = useInboxQuery(() => list({}), 20_000);
  const saved = settings.status === 'ready' ? settings.values.model : '';
  const unavailable = Boolean(saved && data && !data.some(({ value }) => value === saved));
  return (
    <SettingsSection title="Task Inbox agent">
      <SettingsCard>
        <SettingsRow label="Host" hint={host.label} />
        {settings.status === 'loading' && <SettingsRow label="Loading agent settings…" />}
        {settings.status === 'error' && <SettingsAction label={settings.error} actionLabel="Retry" onPress={() => void settings.reload()} />}
        {settings.status === 'invalid' && (
          <SettingsAction label="Saved agent settings need repair" actionLabel="Reset"
            disabled={settings.saving} error={settings.saveError} onPress={() => void settings.reset()} />
        )}
        {error && <SettingsAction label={error} actionLabel="Retry models" onPress={() => void refresh()} />}
        {!data && !error && <SettingsRow label="Loading Codex and Claude Code models…" />}
        {settings.status === 'ready' && data && !error && (
          <SettingsSelect
            label="Model"
            hint={data.length ? 'Task Inbox suggests this model when you choose New chat in the sidebar.' : 'Set up Codex or Claude Code on this host to see available models.'}
            error={settings.saveError ?? (unavailable ? 'The saved model is unavailable.' : null)}
            value={saved}
            options={[
              { value: '', label: 'Choose a model' },
              ...data,
              ...(unavailable ? [{ value: saved, label: `${saved} (unavailable)` }] : []),
            ]}
            disabled={settings.saving}
            onValueChange={(model) => void settings.save({ model }, settings.revision)}
          />
        )}
      </SettingsCard>
    </SettingsSection>
  );
}

export function ScreenshotSettings({ host }: PluginSurfaceProps) {
  const settings = useSettings(screenshotSettings);
  const [origin, setOrigin] = useState('');
  const savedOrigin = settings.status === 'ready' ? settings.values.privateOrigin : '';
  useEffect(() => {
    setOrigin(savedOrigin);
  }, [host.id, savedOrigin]);
  const edited = origin.trim();
  const invalid = Boolean(edited && !privateUploadOrigin(edited));
  return (
    <SettingsSection title="Screenshot uploads">
      <SettingsCard>
        <SettingsRow label="Host" hint={host.label} />
        {settings.status === 'loading' && <SettingsRow label="Loading screenshot settings…" />}
        {settings.status === 'error' && (
          <SettingsAction label={settings.error} actionLabel="Retry" onPress={() => void settings.reload()} />
        )}
        {settings.status === 'invalid' && (
          <SettingsAction
            label="Saved screenshot settings need repair"
            actionLabel="Reset"
            disabled={settings.saving}
            error={settings.saveError}
            onPress={() => void settings.reset()}
          />
        )}
        {settings.status === 'ready' && (
          <>
            <SettingsInput
              label="Private Tailscale address"
              hint="Use this host’s HTTPS Tailscale Serve address for the native mobile browser uploader. Desktop and web attach directly in Task Inbox."
              key={settings.revision}
              initialValue={savedOrigin}
              onChangeText={setOrigin}
              placeholder="https://host.tailnet.ts.net"
              disabled={settings.saving}
              error={invalid ? 'Enter an HTTPS Tailscale address with no path.' : undefined}
            />
            <SettingsAction
              label={settings.saving ? 'Saving…' : 'Upload address'}
              actionLabel="Save"
              disabled={settings.saving || invalid || edited === savedOrigin}
              error={settings.saveError}
              onPress={() => void settings.save({ privateOrigin: edited }, settings.revision)}
            />
          </>
        )}
      </SettingsCard>
    </SettingsSection>
  );
}
