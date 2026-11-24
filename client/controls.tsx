import type { PluginSurfaceProps } from '@getpaseo/plugin/client';
import { ExternalLink, Icon, ScrollView } from '@getpaseo/plugin/client/ui';
import type { ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';

export type Colors = PluginSurfaceProps['theme']['colors'];

export const statusLabel = {
  inbox: 'In inbox',
  queued: 'Queued',
  working: 'Working',
  blocked: 'Blocked',
  completed: 'Completed',
} as const;

export function Page({
  children,
  theme,
}: Pick<PluginSurfaceProps, 'theme'> & { children: ReactNode }) {
  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
      contentContainerStyle={{ padding: 12, alignItems: 'center' }}
    >
      <View style={{ width: '100%', maxWidth: 696, gap: 20 }}>{children}</View>
    </ScrollView>
  );
}

export function Copy({
  colors, children, heading = false, muted = false, error = false, size = 14,
}: {
  colors: Colors;
  children: ReactNode;
  heading?: boolean;
  muted?: boolean;
  error?: boolean;
  size?: number;
}) {
  return (
    <Text
      accessibilityRole={heading ? 'header' : undefined}
      accessibilityLiveRegion={error ? 'polite' : undefined}
      style={{
        color: error ? colors.statusDanger : muted ? colors.foregroundMuted : colors.foreground,
        fontSize: size,
        lineHeight: size + 6,
        fontWeight: heading ? '600' : '400',
        flexShrink: 1,
      }}
    >
      {children}
    </Text>
  );
}

export function Action({
  colors, label, icon, onPress, disabled = false, primary = false,
}: {
  colors: Colors;
  label: string;
  icon?: string;
  onPress: () => void;
  disabled?: boolean;
  primary?: boolean;
}) {
  const foreground = primary ? colors.accentForeground : colors.foreground;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        opacity: disabled ? 0.45 : pressed ? 0.75 : 1,
        backgroundColor: primary ? colors.accent : colors.surface1,
        borderColor: primary ? colors.accent : colors.border,
        borderWidth: 1,
        borderRadius: 8,
        minHeight: 44,
        maxWidth: '100%',
        alignSelf: 'flex-start',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 7,
        paddingHorizontal: 12,
        paddingVertical: 8,
      })}
    >
      {icon && <Icon name={icon} size={16} color={foreground} />}
      <Text style={{ color: foreground, fontWeight: '600', fontSize: 14, flexShrink: 1 }}>{label}</Text>
    </Pressable>
  );
}

export function VerifiedPr({ colors, url }: { colors: Colors; url?: string }) {
  const pr = url?.match(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/([1-9]\d*)$/);
  if (!pr || !url) return null;
  return (
    <ExternalLink href={url} accessibilityLabel={`Open verified PR ${pr[1]}`}>
      <View style={{ minHeight: 44, justifyContent: 'center' }}>
        <Text style={{ color: colors.accent }}>Verified PR #{pr[1]}</Text>
      </View>
    </ExternalLink>
  );
}
