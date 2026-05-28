/**
 * UploadQueueItem
 *
 * A single row in the upload queue:
 *  [Thumbnail] [Filename + size + status text] [Progress bar] [Action button]
 *
 * Swipe-to-remove is handled by wrapping in a gesture in UploadQueue.
 */

import React, { memo } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useTheme } from '../../theme/ThemeProvider';
import { FontSize, FontWeight, Radius, Shadow, Spacing } from '../../theme/tokens';
import { UploadFile } from '../../types';
import { UploadThumbnail } from './UploadThumbnail';
import { UploadProgressBar } from './UploadProgressBar';

interface Props {
  file:         UploadFile;
  onCancel:     (id: string) => void;
  onRemove:     (id: string) => void;
  onRetry:      (id: string) => void;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k     = 1024;
  const units = ['B', 'KB', 'MB', 'GB'];
  const i     = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${units[i]}`;
}

function statusLabel(file: UploadFile): string {
  switch (file.status) {
    case 'pending':   return 'Waiting…';
    case 'uploading': return `Uploading ${file.progress}%${file.elapsedSec ? ` · ${file.elapsedSec}s` : ''}`;
    case 'done':      return 'Uploaded ✓';
    case 'error':     return file.error ? `Failed: ${file.error.slice(0, 60)}` : 'Upload failed';
    case 'cancelled': return 'Cancelled';
    default:          return '';
  }
}

function statusColor(file: UploadFile, colors: ReturnType<typeof useTheme>['colors']): string {
  switch (file.status) {
    case 'uploading': return colors.primary;
    case 'done':      return colors.success;
    case 'error':     return colors.error;
    case 'cancelled': return colors.textTertiary;
    default:          return colors.textSecondary;
  }
}

export const UploadQueueItem = memo(function UploadQueueItem({
  file,
  onCancel,
  onRemove,
  onRetry,
}: Props) {
  const { colors } = useTheme();

  return (
    <View
      style={[
        styles.row,
        {
          backgroundColor: colors.surface,
          borderColor:      colors.border,
        },
      ]}
      accessibilityLabel={`${file.name}, ${statusLabel(file)}`}
    >
      {/* Thumbnail */}
      <UploadThumbnail
        uri={file.uri}
        mimeType={file.mimeType}
        status={file.status}
        size={52}
        style={styles.thumb}
      />

      {/* Info */}
      <View style={styles.info}>
        <Text
          style={[styles.filename, { color: colors.text }]}
          numberOfLines={1}
          ellipsizeMode="middle"
        >
          {file.name}
        </Text>
        <Text style={[styles.meta, { color: colors.textTertiary }]}>
          {formatBytes(file.size)}
        </Text>
        <Text
          style={[styles.statusText, { color: statusColor(file, colors) }]}
          numberOfLines={1}
        >
          {statusLabel(file)}
        </Text>

        {/* Progress bar — only visible while uploading */}
        {(file.status === 'uploading' || file.status === 'pending') && (
          <UploadProgressBar
            progress={file.progress}
            status={file.status}
            height={3}
            style={styles.bar}
          />
        )}

        {/* Done: thin green bar */}
        {file.status === 'done' && (
          <UploadProgressBar
            progress={100}
            status="done"
            height={3}
            style={styles.bar}
          />
        )}
      </View>

      {/* Action */}
      <View style={styles.action}>
        {file.status === 'uploading' && (
          <Pressable
            onPress={() => onCancel(file.id)}
            style={[styles.btn, { backgroundColor: colors.errorLight }]}
            accessibilityLabel="Cancel upload"
            accessibilityRole="button"
            hitSlop={8}
          >
            <Text style={[styles.btnText, { color: colors.error }]}>✕</Text>
          </Pressable>
        )}

        {file.status === 'error' && (
          <Pressable
            onPress={() => onRetry(file.id)}
            style={[styles.btn, { backgroundColor: colors.primaryLight }]}
            accessibilityLabel="Retry upload"
            accessibilityRole="button"
            hitSlop={8}
          >
            <Text style={[styles.btnText, { color: colors.primary }]}>↺</Text>
          </Pressable>
        )}

        {(file.status === 'done' || file.status === 'cancelled' || file.status === 'pending') && (
          <Pressable
            onPress={() => onRemove(file.id)}
            style={[styles.btn, { backgroundColor: colors.surfaceElevated }]}
            accessibilityLabel="Remove from queue"
            accessibilityRole="button"
            hitSlop={8}
          >
            <Text style={[styles.btnText, { color: colors.textSecondary }]}>✕</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  row: {
    flexDirection:  'row',
    alignItems:     'center',
    borderRadius:   Radius.xl,
    borderWidth:    1,
    padding:        Spacing.sm,
    gap:            Spacing.sm,
    ...Shadow.sm,
  },
  thumb: {
    flexShrink: 0,
  },
  info: {
    flex:    1,
    gap:     2,
  },
  filename: {
    fontSize:   FontSize.sm,
    fontWeight: FontWeight.semibold,
  },
  meta: {
    fontSize: FontSize.xs,
  },
  statusText: {
    fontSize: FontSize.xs,
  },
  bar: {
    marginTop: Spacing.xs,
  },
  action: {
    flexShrink: 0,
  },
  btn: {
    width:        28,
    height:       28,
    borderRadius: Radius.full,
    alignItems:   'center',
    justifyContent: 'center',
  },
  btnText: {
    fontSize:   FontSize.base,
    fontWeight: FontWeight.bold,
    lineHeight: 20,
  },
});
