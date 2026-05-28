/**
 * UploadQueue
 *
 * Full scrollable list of queued UploadFiles with:
 *  - Global controls: Upload All · Clear Done · Clear All
 *  - Per-item: cancel / retry / remove via UploadQueueItem
 *  - Summary strip (N files · X MB · Y done)
 */

import React, { useCallback } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  ViewStyle,
} from 'react-native';
import { useTheme } from '../../theme/ThemeProvider';
import { FontSize, FontWeight, Radius, Shadow, Spacing } from '../../theme/tokens';
import { UploadFile } from '../../types';
import { UploadQueueItem } from './UploadQueueItem';
import { UseFileUploadReturn } from '../../hooks/useFileUpload';

interface Props {
  hook:  UseFileUploadReturn;
  style?: ViewStyle;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k     = 1024;
  const units = ['B', 'KB', 'MB', 'GB'];
  const i     = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${units[i]}`;
}

export function UploadQueue({ hook, style }: Props) {
  const { colors } = useTheme();
  const {
    files,
    uploadAll,
    cancelUpload,
    removeFile,
    clearDone,
    clearAll,
    isUploading,
    stats,
  } = hook;

  const handleRetry = useCallback((id: string) => {
    hook.retryUpload(id);
  }, [hook.retryUpload]);

  if (files.length === 0) return null;

  const hasPending = stats.pending > 0 || stats.failed > 0;
  const hasDone    = stats.done > 0;

  return (
    <View style={[styles.container, style]}>

      {/* ── Summary strip ───────────────────────────────────────────────── */}
      <View style={[styles.summary, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <Text style={[styles.summaryText, { color: colors.textSecondary }]}>
          {stats.total} file{stats.total !== 1 ? 's' : ''}
          {' · '}{formatBytes(stats.totalBytes)}
        </Text>
        {stats.done > 0 && (
          <Text style={[styles.summaryDone, { color: colors.success }]}>
            {stats.done} done
          </Text>
        )}
        {stats.failed > 0 && (
          <Text style={[styles.summaryFail, { color: colors.error }]}>
            {stats.failed} failed
          </Text>
        )}
        {stats.uploading > 0 && (
          <Text style={[styles.summaryUp, { color: colors.primary }]}>
            {stats.uploading} uploading
          </Text>
        )}
      </View>

      {/* ── File list ───────────────────────────────────────────────────── */}
      <ScrollView
        style={styles.list}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
        nestedScrollEnabled
      >
        {files.map((file: UploadFile) => (
          <UploadQueueItem
            key={file.id}
            file={file}
            onCancel={cancelUpload}
            onRemove={removeFile}
            onRetry={handleRetry}
          />
        ))}
      </ScrollView>

      {/* ── Global controls ─────────────────────────────────────────────── */}
      <View style={[styles.controls, { borderTopColor: colors.border }]}>
        {hasPending && !isUploading && (
          <Pressable
            onPress={uploadAll}
            style={[styles.ctaBtn, { backgroundColor: colors.primary }, Shadow.md]}
            accessibilityRole="button"
            accessibilityLabel="Upload all pending files"
          >
            <Text style={styles.ctaBtnText}>
              ↑ Upload All ({stats.pending + stats.failed})
            </Text>
          </Pressable>
        )}

        {isUploading && (
          <View style={[styles.ctaBtn, { backgroundColor: colors.surfaceElevated }]}>
            <Text style={[styles.ctaBtnText, { color: colors.primary }]}>
              Uploading {stats.uploading} file{stats.uploading !== 1 ? 's' : ''}…
            </Text>
          </View>
        )}

        <View style={styles.secondaryRow}>
          {hasDone && (
            <Pressable
              onPress={clearDone}
              style={[styles.secondaryBtn, { borderColor: colors.border }]}
              accessibilityRole="button"
              accessibilityLabel="Clear completed files"
            >
              <Text style={[styles.secondaryBtnText, { color: colors.textSecondary }]}>
                Clear Done
              </Text>
            </Pressable>
          )}
          <Pressable
            onPress={clearAll}
            style={[styles.secondaryBtn, { borderColor: colors.error }]}
            accessibilityRole="button"
            accessibilityLabel="Clear all files and cancel uploads"
          >
            <Text style={[styles.secondaryBtnText, { color: colors.error }]}>
              Clear All
            </Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  summary: {
    flexDirection:  'row',
    alignItems:     'center',
    gap:            Spacing.sm,
    paddingHorizontal: Spacing.base,
    paddingVertical:   Spacing.xs,
    borderRadius:   Radius.xl,
    borderWidth:    1,
    marginBottom:   Spacing.sm,
    flexWrap:       'wrap',
  },
  summaryText: {
    fontSize: FontSize.xs,
    flex:     1,
  },
  summaryDone: { fontSize: FontSize.xs, fontWeight: FontWeight.semibold },
  summaryFail: { fontSize: FontSize.xs, fontWeight: FontWeight.semibold },
  summaryUp:   { fontSize: FontSize.xs, fontWeight: FontWeight.semibold },
  list: {
    flex: 1,
  },
  listContent: {
    gap:           Spacing.sm,
    paddingBottom: Spacing.md,
  },
  controls: {
    paddingTop:  Spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap:         Spacing.sm,
  },
  ctaBtn: {
    borderRadius:   Radius.xl,
    paddingVertical: Spacing.md,
    alignItems:     'center',
  },
  ctaBtnText: {
    color:      '#fff',
    fontSize:   FontSize.base,
    fontWeight: FontWeight.bold,
  },
  secondaryRow: {
    flexDirection: 'row',
    gap:           Spacing.sm,
  },
  secondaryBtn: {
    flex:           1,
    borderRadius:   Radius.xl,
    paddingVertical: Spacing.sm,
    alignItems:     'center',
    borderWidth:    1,
  },
  secondaryBtnText: {
    fontSize:   FontSize.sm,
    fontWeight: FontWeight.semibold,
  },
});
