/**
 * FileUploadPicker
 *
 * A floating action button (FAB) that expands into a bottom-sheet style
 * option tray offering:
 *   📷 Camera
 *   🖼  Gallery
 *   📄 Documents
 *
 * Uses Reanimated for smooth open/close animation — zero frame drops.
 */

import React, { useState, useCallback } from 'react';
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TouchableWithoutFeedback,
  View,
} from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useTheme } from '../../theme/ThemeProvider';
import { FontSize, FontWeight, Radius, Shadow, Spacing } from '../../theme/tokens';

interface Props {
  onPickCamera:    () => Promise<void>;
  onPickGallery:   () => Promise<void>;
  onPickDocuments: () => Promise<void>;
  disabled?:       boolean;
}

interface Option {
  icon:  string;
  label: string;
  onPress: () => Promise<void>;
}

export function FileUploadPicker({
  onPickCamera,
  onPickGallery,
  onPickDocuments,
  disabled = false,
}: Props) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);

  const scaleAnim   = useSharedValue(0);
  const opacityAnim = useSharedValue(0);

  const openSheet = useCallback(() => {
    setOpen(true);
    scaleAnim.value   = withSpring(1, { damping: 18, stiffness: 260 });
    opacityAnim.value = withTiming(1, { duration: 180 });
  }, [scaleAnim, opacityAnim]);

  const closeSheet = useCallback(() => {
    scaleAnim.value   = withTiming(0, { duration: 160 });
    opacityAnim.value = withTiming(0, { duration: 160 });
    setTimeout(() => setOpen(false), 160);
  }, [scaleAnim, opacityAnim]);

  const sheetStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scaleAnim.value }],
    opacity:   opacityAnim.value,
  }));

  const options: Option[] = [
    { icon: '📷', label: 'Camera',    onPress: onPickCamera },
    { icon: '🖼️', label: 'Gallery',   onPress: onPickGallery },
    { icon: '📄', label: 'Documents', onPress: onPickDocuments },
  ];

  const handleOption = useCallback(async (opt: Option) => {
    closeSheet();
    await new Promise((r) => setTimeout(r, 200)); // wait for close anim
    await opt.onPress();
  }, [closeSheet]);

  return (
    <>
      {/* FAB */}
      <Pressable
        onPress={openSheet}
        disabled={disabled}
        style={({ pressed }) => [
          styles.fab,
          {
            backgroundColor: colors.primary,
            opacity:          disabled ? 0.5 : pressed ? 0.85 : 1,
          },
          Shadow.lg,
        ]}
        accessibilityLabel="Add files to upload"
        accessibilityRole="button"
        accessibilityHint="Opens file picker options"
      >
        <Text style={styles.fabIcon}>+</Text>
      </Pressable>

      {/* Bottom-sheet modal */}
      {open && (
        <Modal transparent animationType="none" onRequestClose={closeSheet}>
          <TouchableWithoutFeedback onPress={closeSheet}>
            <View style={styles.backdrop} />
          </TouchableWithoutFeedback>

          <Animated.View
            style={[
              styles.sheet,
              { backgroundColor: colors.surface, borderColor: colors.border },
              sheetStyle,
            ]}
          >
            <View style={[styles.handle, { backgroundColor: colors.border }]} />
            <Text style={[styles.sheetTitle, { color: colors.text }]}>
              Add Files
            </Text>

            {options.map((opt) => (
              <Pressable
                key={opt.label}
                onPress={() => handleOption(opt)}
                style={({ pressed }) => [
                  styles.optionRow,
                  {
                    backgroundColor: pressed ? colors.surfaceElevated : 'transparent',
                    borderColor:     colors.border,
                  },
                ]}
                accessibilityRole="button"
                accessibilityLabel={opt.label}
              >
                <Text style={styles.optIcon}>{opt.icon}</Text>
                <Text style={[styles.optLabel, { color: colors.text }]}>{opt.label}</Text>
                <Text style={[styles.optChevron, { color: colors.textTertiary }]}>›</Text>
              </Pressable>
            ))}

            <Pressable
              onPress={closeSheet}
              style={[styles.cancelBtn, { backgroundColor: colors.surfaceElevated }]}
              accessibilityRole="button"
              accessibilityLabel="Cancel"
            >
              <Text style={[styles.cancelText, { color: colors.textSecondary }]}>Cancel</Text>
            </Pressable>
          </Animated.View>
        </Modal>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  fab: {
    position:       'absolute',
    bottom:         Spacing['3xl'],
    right:          Spacing.base,
    width:          56,
    height:         56,
    borderRadius:   Radius.full,
    alignItems:     'center',
    justifyContent: 'center',
    zIndex:         100,
  },
  fabIcon: {
    color:      '#fff',
    fontSize:   FontSize['3xl'],
    fontWeight: FontWeight.regular,
    lineHeight: 56,
    textAlign:  'center',
    marginTop:  -3,
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  sheet: {
    position:     'absolute',
    bottom:       0,
    left:         0,
    right:        0,
    borderTopLeftRadius:  Radius['2xl'],
    borderTopRightRadius: Radius['2xl'],
    borderTopWidth:   1,
    borderLeftWidth:  1,
    borderRightWidth: 1,
    paddingBottom:    Spacing['3xl'],
    paddingTop:       Spacing.md,
    paddingHorizontal: Spacing.base,
    transformOrigin: 'bottom center' as any,
  },
  handle: {
    alignSelf:    'center',
    width:        40,
    height:       4,
    borderRadius: Radius.full,
    marginBottom: Spacing.base,
  },
  sheetTitle: {
    fontSize:    FontSize.lg,
    fontWeight:  FontWeight.bold,
    marginBottom: Spacing.base,
  },
  optionRow: {
    flexDirection:  'row',
    alignItems:     'center',
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.sm,
    borderRadius:   Radius.lg,
    gap:            Spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  optIcon: {
    fontSize: FontSize.xl,
    width:    32,
    textAlign: 'center',
  },
  optLabel: {
    flex:       1,
    fontSize:   FontSize.base,
    fontWeight: FontWeight.medium,
  },
  optChevron: {
    fontSize:   FontSize['2xl'],
    lineHeight: FontSize['2xl'],
  },
  cancelBtn: {
    marginTop:    Spacing.base,
    borderRadius: Radius.xl,
    paddingVertical: Spacing.md,
    alignItems:   'center',
  },
  cancelText: {
    fontSize:   FontSize.base,
    fontWeight: FontWeight.semibold,
  },
});
