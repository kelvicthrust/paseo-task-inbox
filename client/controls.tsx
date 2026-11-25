import type { PluginSurfaceProps } from '@getpaseo/plugin/client';
import { ExternalLink, Icon, ScrollView } from '@getpaseo/plugin/client/ui';
import type { ReactNode, Ref } from 'react';
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
  children, footer, theme, scrollRef,
}: Pick<PluginSurfaceProps, 'theme'> & { children: ReactNode; footer?: ReactNode; scrollRef?: Ref<import('react-native').ScrollView> }) {
  return (
    <View style={{ flex: 1, minHeight: 0, backgroundColor: theme.colors.surface0 }}>
      <ScrollView
        ref={scrollRef}
        keyboardShouldPersistTaps="handled"
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 12, alignItems: 'center' }}
      >
        <View style={{ width: '100%', maxWidth: 696, gap: 20 }}>{children}</View>
      </ScrollView>
      {footer && (
        <View style={{
          alignItems: 'center', borderTopColor: theme.colors.border, borderTopWidth: 1,
          paddingHorizontal: 12, paddingVertical: 8, backgroundColor: theme.colors.surface0,
        }}>
          <View style={{ width: '100%', maxWidth: 696, gap: 6 }}>{footer}</View>
        </View>
      )}
    </View>
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
  colors, label, icon, onPress, disabled = false, primary = false, subtle = false,
  danger = false, compact = false, focusRef, expanded, accessibilityLabel,
}: {
  colors: Colors;
  label: string;
  icon?: string;
  onPress: () => void;
  disabled?: boolean;
  primary?: boolean;
  subtle?: boolean;
  danger?: boolean;
  compact?: boolean;
  focusRef?: Ref<View>;
  expanded?: boolean;
  accessibilityLabel?: string;
}) {
  const foreground = primary ? colors.accentForeground : danger ? colors.statusDanger : colors.foreground;
  return (
    <Pressable
      ref={focusRef}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled, expanded }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        opacity: disabled ? 0.45 : pressed ? 0.75 : 1,
        backgroundColor: primary ? colors.accent : subtle ? 'transparent' : colors.surface1,
        borderColor: primary ? colors.accent : colors.border,
        borderWidth: subtle ? 0 : 1,
        borderRadius: 8,
        minHeight: compact ? 34 : 44,
        maxWidth: '100%',
        alignSelf: 'flex-start',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 7,
        paddingHorizontal: compact ? 8 : 12,
        paddingVertical: compact ? 5 : 8,
      })}
    >
      {icon && <Icon name={icon} size={16} color={foreground} />}
      <Text style={{ color: foreground, fontWeight: '600', fontSize: 14, flexShrink: 1 }}>{label}</Text>
    </Pressable>
  );
}

export function IconAction({
  colors, icon, label, onPress, disabled = false, expanded, focusRef, compact = false, checked,
}: {
  colors: Colors;
  icon: string;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  expanded?: boolean;
  focusRef?: Ref<View>;
  compact?: boolean;
  checked?: boolean;
}) {
  return (
    <Pressable
      ref={focusRef}
      accessibilityRole={checked === undefined ? 'button' : 'checkbox'}
      accessibilityLabel={label}
      accessibilityState={{ checked, disabled, expanded }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed, hovered, focused }: { pressed: boolean; hovered?: boolean; focused?: boolean }) => ({
        opacity: disabled ? 0.5 : 1,
        backgroundColor: pressed || hovered || focused || expanded ? colors.surface2 : 'transparent',
        alignItems: 'center',
        justifyContent: 'center',
        width: compact ? 34 : 44,
        height: compact ? 34 : 44,
        borderRadius: 6,
      })}
    >
      <Icon name={icon} size={17} color={checked ? colors.accent : colors.foregroundMuted} />
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
