/**
 * UploadProgressBar
 *
 * Reanimated-driven animated progress bar.
 * Colour transitions: idle → uploading (primary) → done (success) → error (error)
 * Zero frame drops: all animation runs on the UI thread via useAnimatedStyle.
 */

import React, { useEffect } from 'react';
import { StyleSheet, View, ViewStyle } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  interpolateColor,
  Easing,
} from 'react-native-reanimated';
import { useTheme } from '../../theme/ThemeProvider';
import { Radius } from '../../theme/tokens';
import { UploadStatus } from '../../types';

interface Props {
  progress: number;   // 0-100
  status:   UploadStatus;
  height?:  number;
  style?:   ViewStyle;
}

export function UploadProgressBar({ progress, status, height = 4, style }: Props) {
  const { colors } = useTheme();

  const animatedWidth    = useSharedValue(0);
  const animatedColorPct = useSharedValue(0); // 0 = primary, 1 = success/error

  useEffect(() => {
    animatedWidth.value = withTiming(progress / 100, {
      duration: 300,
      easing:   Easing.out(Easing.cubic),
    });
  }, [progress, animatedWidth]);

  useEffect(() => {
    const target =
      status === 'done'  ? 1 :
      status === 'error' ? 2 :
      0;
    animatedColorPct.value = withTiming(target, { duration: 400 });
  }, [status, animatedColorPct]);

  const barStyle = useAnimatedStyle(() => {
    const color = interpolateColor(
      animatedColorPct.value,
      [0, 1, 2],
      [colors.primary, colors.success, colors.error],
    );
    return {
      width:           `${animatedWidth.value * 100}%`,
      backgroundColor: color,
    };
  });

  return (
    <View
      style={[
        styles.track,
        { height, backgroundColor: colors.border, borderRadius: Radius.full },
        style,
      ]}
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: progress }}
    >
      <Animated.View
        style={[
          styles.fill,
          { height, borderRadius: Radius.full },
          barStyle,
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    overflow: 'hidden',
    width:    '100%',
  },
  fill: {
    position: 'absolute',
    left:     0,
    top:      0,
  },
});
