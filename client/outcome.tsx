import type { PluginTimelineItemProps } from '@getpaseo/plugin/client';
import { Icon } from '@getpaseo/plugin/client/ui';
import type { z } from 'zod';
import { View } from 'react-native';
import type { batchOutcomeSchema } from '../shared/outcome.ts';
import { Copy, VerifiedPr, statusLabel } from './controls.tsx';

export function BatchOutcome({ item, theme }: PluginTimelineItemProps<z.output<typeof batchOutcomeSchema>>) {
  const colors = theme.colors;
  return (
    <View style={{ borderColor: colors.border, borderWidth: 1, borderRadius: 9, padding: 14, gap: 10, backgroundColor: colors.surface1 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Icon name="Inbox" color={colors.foregroundMuted} size={17} />
        <Copy colors={colors} heading size={16}>Task Inbox results</Copy>
      </View>
      {item.data.items.map((outcome) => (
        <View key={outcome.number} style={{ gap: 4 }}>
          <Copy colors={colors} heading>#{outcome.number} · {statusLabel[outcome.status]}</Copy>
          {outcome.detail && <Copy colors={colors} muted>{outcome.detail}</Copy>}
          {outcome.status === 'completed' && <VerifiedPr colors={colors} url={outcome.prUrl} />}
        </View>
      ))}
    </View>
  );
}
