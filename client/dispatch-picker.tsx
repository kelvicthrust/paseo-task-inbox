/// <reference lib="dom" />

import { Icon, ScrollView } from '@getpaseo/plugin/client/ui';
import { useEffect, useRef, useState, type ReactNode, type Ref, type RefObject } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { type Colors } from './controls.tsx';

export function DispatchChoice({
  colors, label, detail, icon, trailingIcon, status, compact, trigger, expanded, disabled,
  selected, focusRef, accessibilityLabel, onPress,
}: {
  colors: Colors;
  label: string;
  detail?: string;
  icon?: string;
  trailingIcon?: string;
  status?: string;
  compact: boolean;
  trigger?: boolean;
  expanded?: boolean;
  disabled?: boolean;
  selected?: boolean;
  focusRef?: Ref<View>;
  accessibilityLabel?: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      ref={focusRef}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? [label, detail, status].filter(Boolean).join(', ')}
      accessibilityState={{ disabled, expanded, selected: compact ? undefined : selected }}
      {...(compact && selected !== undefined ? { 'aria-pressed': selected } : {})}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed, hovered, focused }: { pressed: boolean; hovered?: boolean; focused?: boolean }) => ({
        minHeight: trigger ? 44 : compact ? 36 : 44,
        minWidth: 0,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 7,
        borderRadius: trigger ? 8 : 6,
        borderWidth: trigger ? 1 : 0,
        borderColor: expanded || focused ? colors.accent : colors.border,
        paddingHorizontal: 8,
        paddingVertical: 5,
        opacity: disabled ? 0.55 : 1,
        backgroundColor: pressed || hovered || focused || expanded || selected
          ? colors.surface2 : trigger ? colors.surface1 : 'transparent',
      })}
    >
      {icon && <Icon name={icon} size={15} color={colors.accent} />}
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text numberOfLines={trigger ? 1 : 2} style={{ color: colors.foreground, fontSize: 13, fontWeight: '600' }}>
          {label}
        </Text>
        {detail && <Text numberOfLines={1} style={{ color: colors.foregroundMuted, fontSize: 11 }}>{detail}</Text>}
      </View>
      {status && <Text style={{ color: colors.statusWarning, fontSize: 11, fontWeight: '600' }}>{status}</Text>}
      {(trailingIcon || selected) && (
        <Icon name={trailingIcon ?? 'Check'} size={14} color={selected ? colors.accent : colors.foregroundMuted} />
      )}
    </Pressable>
  );
}

export function DispatchPicker({
  anchor, anchorHeight, panel, colors, web, title, dismiss, children,
}: {
  anchor: RefObject<View | null>;
  anchorHeight: number;
  panel: RefObject<View | null>;
  colors: Colors;
  web: boolean;
  title: string;
  dismiss: () => void;
  children: ReactNode;
}) {
  const layer = useRef<View>(null);
  const [size, setSize] = useState<{ width: number; height: number }>();
  const [position, setPosition] = useState<{ bottom: number; left: number; width: number; maxHeight: number }>();
  const visible = Boolean(position && position.maxHeight > 0);

  useEffect(() => {
    if (!size || size.height <= 0) return;
    let live = true;
    layer.current?.measureInWindow((layerX, layerY) => {
      anchor.current?.measureInWindow((x, y, width) => {
        if (!live) return;
        const gap = 5;
        const top = y - layerY;
        const above = top - gap * 2;
        const available = size.height - gap * 2;
        const clearsFooter = above >= Math.min(96, available);
        setPosition({
          bottom: clearsFooter ? size.height - top + gap : gap,
          left: x - layerX,
          width,
          maxHeight: Math.max(0, Math.min(280, clearsFooter ? above : available)),
        });
      });
    });
    return () => { live = false; };
  }, [anchor, anchorHeight, size]);

  function options() {
    const element = panel.current as unknown as HTMLElement | null;
    return Array.from(element?.querySelectorAll<HTMLElement>('[role="button"]:not([aria-disabled="true"])') ?? []);
  }

  useEffect(() => {
    if (!web || !visible) return;
    const choices = options();
    (choices.find((choice) => choice.getAttribute('aria-pressed') === 'true') ?? choices[0] ?? panel.current)?.focus();
  }, [visible, web]);

  useEffect(() => {
    if (!web || !visible) return;
    // A catalog refresh can remove the focused option from the DOM.
    const element = panel.current as unknown as HTMLElement | null;
    if (element && element.ownerDocument.activeElement === element.ownerDocument.body) element.focus();
  }, [children, visible, web]);

  const overlay = (
    <View
      ref={layer}
      collapsable={false}
      onLayout={({ nativeEvent: { layout: { width, height } } }) => setSize({ width, height })}
      pointerEvents={visible ? 'auto' : 'none'}
      style={[StyleSheet.absoluteFill, { zIndex: 1 }]}
      accessibilityViewIsModal
    >
      <Pressable accessible={false} focusable={false} onPress={dismiss} style={StyleSheet.absoluteFill} />
      <View
        ref={panel}
        role="group"
        tabIndex={web ? -1 : undefined}
        accessibilityLabel={title}
        accessibilityElementsHidden={!visible}
        importantForAccessibility={visible ? 'auto' : 'no-hide-descendants'}
        pointerEvents={visible ? 'auto' : 'none'}
        style={{
          position: 'absolute', ...position, opacity: visible ? 1 : 0,
          backgroundColor: colors.surface1, borderWidth: 1, borderColor: colors.border, borderRadius: 8,
        }}
      >
        <ScrollView
          keyboardShouldPersistTaps="handled"
          style={{ flexGrow: 0, maxHeight: position ? Math.max(0, position.maxHeight - 2) : undefined }}
          contentContainerStyle={{ padding: 4 }}
        >
          {children}
        </ScrollView>
      </View>
    </View>
  );

  return web ? (
    <div style={{ display: 'contents' }} onKeyDown={(event) => {
      const choices = options();
      const index = choices.findIndex((choice) => Object.is(choice, event.target));
      if (event.key === 'Escape') {
        event.stopPropagation();
        dismiss();
      } else if (event.key === 'Tab' && (!choices.length || (event.shiftKey ? index <= 0 : index === choices.length - 1))) {
        // Continue tabbing from the trigger's place in the footer.
        dismiss();
      } else if (choices.length && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        event.stopPropagation();
        const last = choices.length - 1;
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? last
          : event.key === 'ArrowDown' ? (index + 1) % choices.length : index <= 0 ? last : index - 1;
        choices[next]?.focus();
      }
    }}>{overlay}</div>
  ) : overlay;
}
