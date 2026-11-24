import { useSettings, type PluginSurfaceProps } from '@getpaseo/plugin/client';
import { SettingsAction, SettingsCard, SettingsInput, SettingsRow, SettingsSection } from '@getpaseo/plugin/client/ui';
import { useEffect, useState } from 'react';
import { privateUploadOrigin, screenshotSettings } from '../shared/screenshot.ts';

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
              hint="Use this host’s HTTPS Tailscale Serve address for phone or remote desktop uploads. Leave blank for a browser on this host."
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
