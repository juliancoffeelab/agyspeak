import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { AudioMetadata } from './history';
import type { ChatColors } from './theme';

export function AudioWaveform({ levels, color }: { levels: number[]; color: string }) {
  // Peak aggregation keeps the full recording visible in a strip that shrinks to its available width.
  const count = Math.min(32, levels.length);
  return <View style={styles.wave} accessible accessibilityLabel="Recorded audio levels">
    {Array.from({ length: count }, (_, index) => {
      const start = Math.floor(index * levels.length / count);
      const end = Math.max(start + 1, Math.floor((index + 1) * levels.length / count));
      const level = Math.max(...levels.slice(start, end));
      return <View key={index} style={{ flex: 1, maxWidth: 3, minWidth: 1, height: Math.max(3, Math.min(1, level) * 30), borderRadius: 2, backgroundColor: color }} />;
    })}
  </View>;
}

export function LiveAudioWaveform({ levels, color }: { levels: number[]; color: string }) {
  const [width, setWidth] = useState(0);
  const capacity = Math.max(0, Math.floor((width + 3) / 6));
  const visible = capacity > 0 ? levels.slice(-capacity).map((level, offset) => ({
    level, sample: levels.length - Math.min(capacity, levels.length) + offset,
  })) : [];
  return <View style={styles.liveWave} onLayout={event => setWidth(event.nativeEvent.layout.width)}
    accessible accessibilityLabel="Live audio levels">
    {visible.map(({ level, sample }, offset) => <View key={sample}
      style={{ opacity: Math.min(1, (offset + 1) / 4, (visible.length - offset) / 4), width: 3, height: Math.max(3, Math.min(1, level) * 30), borderRadius: 2, backgroundColor: color }} />)}
  </View>;
}

export function audioTime(milliseconds: number) {
  const seconds = Math.floor(milliseconds / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function AudioMessage({ audio, colors }: { audio: AudioMetadata; colors: ChatColors }) {
  return <View style={styles.message} accessible accessibilityLabel={`Voice message${audio.durationMillis ? `, ${audioTime(audio.durationMillis)}` : ''}`}>
    <View style={styles.caption}>
      <Text style={{ color: colors.text, fontSize: 16 }}>Voice message</Text>
      <Text style={{ color: colors.muted }}>{audio.durationMillis ? audioTime(audio.durationMillis) : audio.format.toUpperCase()}</Text>
    </View>
    {audio.levels?.length ? <AudioWaveform levels={audio.levels} color={colors.text} /> : <View style={[styles.track, { backgroundColor: colors.muted }]} />}
  </View>;
}

const styles = StyleSheet.create({
  wave: { height: 32, width: '100%', maxWidth: 192, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 2 },
  liveWave: { height: 32, width: '100%', flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 3, overflow: 'hidden' },
  message: { minWidth: 180, gap: 10, paddingVertical: 2 },
  caption: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 20 },
  track: { height: 3, width: 180, borderRadius: 2, marginVertical: 14 },
});
