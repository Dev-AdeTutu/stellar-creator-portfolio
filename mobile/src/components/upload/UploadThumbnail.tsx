/**
 * UploadThumbnail
 *
 * Shows a thumbnail for image/video files, or a document icon for other types.
 * Overlays a status badge (spinner, checkmark, error, cancelled).
 */

import React from 'react';
import {
  ActivityIndicator,
  Image,
  StyleSheet,
  Text,
  View,
  ViewStyle,
} from 'react-native';
import { useTheme } from '../../theme/ThemeProvider';
import { Radius, FontSize } from '../../theme/tokens';
import { UploadStatus } from '../../types';

interface Props {
  uri:      string;
  mimeType: string;
  status:   UploadStatus;
  size?:    number;
  style?:   ViewStyle;
}

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic'];
const VIDEO_TYPES = ['video/mp4', 'video/quicktime', 'video/webm'];

function isImage(mime: string) { return IMAGE_TYPES.some((t) => mime.startsWith(t.split('/')[0]) && mime.includes('image')); }
function isVideo(mime: string) { return VIDEO_TYPES.some((t) => mime.startsWith('video')); }

function DocIcon({ mime, size }: { mime: string; size: number }) {
  const { colors } = useTheme();
  const ext = mime.split('/')[1]?.toUpperCase().slice(0, 4) ?? 'FILE';
  const bg  =
    mime.includes('pdf')   ? '#ef4444' :
    mime.includes('word')  ? '#3b82f6' :
    mime.includes('sheet') ? '#22c55e' :
    mime.includes('zip')   ? '#f59e0b' :
    colors.surfaceElevated;

  return (
    <View style={[styles.docIcon, { width: size, height: size, backgroundColor: bg, borderRadius: Radius.md }]}>
      <Text style={[styles.docExt, { fontSize: size * 0.2, color: '#fff' }]}>{ext}</Text>
    </View>
  );
}

function StatusOverlay({ status, size }: { status: UploadStatus; size: number }) {
  const { colors } = useTheme();
  if (status === 'pending' || status === 'idle') return null;

  const overlaySize = size * 0.38;

  if (status === 'uploading') {
    return (
      <View style={[styles.badge, { width: overlaySize, height: overlaySize, borderRadius: overlaySize / 2, backgroundColor: 'rgba(0,0,0,0.55)' }]}>
        <ActivityIndicator size="small" color="#fff" />
      </View>
    );
  }

  const icon =
    status === 'done'      ? '✓' :
    status === 'error'     ? '✕' :
    status === 'cancelled' ? '⊘' : '';

  const bg =
    status === 'done'      ? colors.success :
    status === 'error'     ? colors.error :
    colors.textTertiary;

  return (
    <View style={[styles.badge, { width: overlaySize, height: overlaySize, borderRadius: overlaySize / 2, backgroundColor: bg }]}>
      <Text style={[styles.badgeIcon, { fontSize: overlaySize * 0.5 }]}>{icon}</Text>
    </View>
  );
}

export function UploadThumbnail({ uri, mimeType, status, size = 56, style }: Props) {
  const showImage = isImage(mimeType) || isVideo(mimeType);

  return (
    <View style={[styles.root, { width: size, height: size }, style]}>
      {showImage ? (
        <Image
          source={{ uri }}
          style={[styles.image, { width: size, height: size, borderRadius: Radius.md }]}
          resizeMode="cover"
        />
      ) : (
        <DocIcon mime={mimeType} size={size} />
      )}

      {isVideo(mimeType) && status === 'pending' && (
        <View style={styles.videoBadge}>
          <Text style={styles.videoBadgeText}>▶</Text>
        </View>
      )}

      <StatusOverlay status={status} size={size} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    position: 'relative',
    alignItems: 'center',
    justifyContent: 'center',
  },
  image: {
    position: 'absolute',
  },
  docIcon: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  docExt: {
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  badge: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeIcon: {
    color: '#fff',
    fontWeight: '700',
  },
  videoBadge: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
  },
  videoBadgeText: {
    color: '#fff',
    fontSize: 14,
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
});
