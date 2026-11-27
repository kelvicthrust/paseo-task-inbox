import { useRpc, type PluginTimelineItemProps } from '@getpaseo/plugin/client';
import { Icon } from '@getpaseo/plugin/client/ui';
import type { z } from 'zod';
import { View } from 'react-native';
import type { batchOutcomeSchema } from '../shared/outcome.ts';
import { readBatchOutcome } from '../shared/rpc.ts';
import { Copy, PullRequestLink, statusLabel } from './controls.tsx';
import { useInboxQuery } from './query.ts';

type OutcomeProps = PluginTimelineItemProps<z.output<typeof batchOutcomeSchema>>;

export function BatchOutcome(props: OutcomeProps) {
  return <LiveBatchOutcome key={JSON.stringify([props.host.id, props.agentId, props.item.data.batchId])} {...props} />;
}

function LiveBatchOutcome({ agentId, item, theme }: OutcomeProps) {
  const colors = theme.colors;
  const read = useRpc(readBatchOutcome);
  const { data } = useInboxQuery(() => read({ agentId, batchId: item.data.batchId }), 10_000);
  const live = new Map(data?.map((task) => [task.number, task]));
  return (
    <View style={{ borderColor: colors.border, borderWidth: 1, borderRadius: 9, padding: 14, gap: 10, backgroundColor: colors.surface1 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Icon name="Inbox" color={colors.foregroundMuted} size={17} />
        <Copy colors={colors} heading size={16}>Task Inbox results</Copy>
      </View>
      {item.data.items.map((snapshot) => {
        const current = live.get(snapshot.number);
        const outcome = current ?? snapshot;
        const prUrl = current ? current.prUrl : snapshot.status === 'completed' ? snapshot.prUrl : undefined;
        const showStatus = outcome.status !== 'blocked' || !current?.prState;
        return (
          <View key={outcome.number} style={{ gap: 4 }}>
            <Copy colors={colors} heading>#{outcome.number}{showStatus ? ` · ${statusLabel[outcome.status]}` : ''}</Copy>
            {outcome.detail && <Copy colors={colors} muted>{outcome.detail}</Copy>}
            <PullRequestLink colors={colors} url={prUrl} state={current?.prState} />
          </View>
        );
      })}
    </View>
  );
}
