/**
 * useFileUpload
 *
 * React hook that orchestrates the full file upload lifecycle:
 *  - Pick files from camera, gallery, or document browser
 *  - Maintain a queue of UploadFile items with per-file progress & status
 *  - Enforce concurrency limit (max 2 simultaneous uploads)
 *  - Cancel individual or all uploads
 *  - Expose summary stats
 */

import { useCallback, useRef, useState } from 'react';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { Platform, Alert } from 'react-native';
import { getBucketUploadService, UploadHandle } from '../services/BucketUploadService';
import { UploadFile, UploadStatus } from '../types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function uid(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function formatFilename(uri: string, fallback: string): string {
  const parts = uri.split('/');
  const last  = parts[parts.length - 1];
  return last && last.includes('.') ? last : fallback;
}

// Max concurrent uploads
const MAX_CONCURRENCY = 2;

// ─── Hook ─────────────────────────────────────────────────────────────────────

export interface UseFileUploadReturn {
  files:          UploadFile[];
  /** Pick images/videos from the device gallery */
  pickImages:     () => Promise<void>;
  /** Capture a photo/video from the camera */
  pickFromCamera: () => Promise<void>;
  /** Pick arbitrary documents */
  pickDocuments:  () => Promise<void>;
  /** Start uploading all pending files (respects concurrency) */
  uploadAll:      () => Promise<void>;
  /** Cancel a specific upload in progress */
  cancelUpload:   (id: string) => void;
  /** Remove a file from the queue */
  removeFile:     (id: string) => void;
  /** Clear completed / errored files */
  clearDone:      () => void;
  /** Clear all files and cancel active uploads */
  clearAll:       () => void;
  /** Retry a failed/cancelled upload */
  retryUpload:    (id: string) => void;
  /** Whether any upload is currently active */
  isUploading:    boolean;
  /** Summary counts */
  stats: {
    total:      number;
    done:       number;
    failed:     number;
    pending:    number;
    uploading:  number;
    totalBytes: number;
    doneBytes:  number;
  };
}

export function useFileUpload(): UseFileUploadReturn {
  const [files, setFiles] = useState<UploadFile[]>([]);

  // Map of upload handles keyed by file id for cancellation
  const handlesRef = useRef<Map<string, UploadHandle>>(new Map());

  // ── Mutate a single file in state ────────────────────────────────────────

  const patchFile = useCallback((id: string, patch: Partial<UploadFile>) => {
    setFiles((prev) =>
      prev.map((f) => (f.id === id ? { ...f, ...patch } : f)),
    );
  }, []);

  // ── Add files to queue ────────────────────────────────────────────────────

  const addFiles = useCallback((incoming: Omit<UploadFile, 'id' | 'progress' | 'status'>[]) => {
    const newFiles: UploadFile[] = incoming.map((f) => ({
      ...f,
      id:       uid(),
      progress: 0,
      status:   'pending' as UploadStatus,
    }));
    setFiles((prev) => [...prev, ...newFiles]);
  }, []);

  // ── Request permissions (iOS needs explicit asks) ─────────────────────────

  const requestCameraPermission = useCallback(async (): Promise<boolean> => {
    if (Platform.OS === 'web') return true;
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission required', 'Camera access is needed to capture photos.');
      return false;
    }
    return true;
  }, []);

  const requestMediaPermission = useCallback(async (): Promise<boolean> => {
    if (Platform.OS === 'web') return true;
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission required', 'Photo library access is needed to pick files.');
      return false;
    }
    return true;
  }, []);

  // ── Pickers ───────────────────────────────────────────────────────────────

  const pickImages = useCallback(async () => {
    const ok = await requestMediaPermission();
    if (!ok) return;

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes:          ImagePicker.MediaTypeOptions.All,
      allowsMultipleSelection: true,
      quality:             0.9,
      exif:                false,
    });

    if (result.canceled) return;

    addFiles(
      result.assets.map((a) => ({
        uri:      a.uri,
        name:     formatFilename(a.uri, `image_${Date.now()}.jpg`),
        mimeType: a.type === 'video' ? 'video/mp4' : 'image/jpeg',
        size:     a.fileSize ?? 0,
      })),
    );
  }, [addFiles, requestMediaPermission]);

  const pickFromCamera = useCallback(async () => {
    const ok = await requestCameraPermission();
    if (!ok) return;

    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.All,
      quality:    0.9,
      exif:       false,
    });

    if (result.canceled) return;

    const a = result.assets[0];
    addFiles([{
      uri:      a.uri,
      name:     formatFilename(a.uri, `capture_${Date.now()}.jpg`),
      mimeType: a.type === 'video' ? 'video/mp4' : 'image/jpeg',
      size:     a.fileSize ?? 0,
    }]);
  }, [addFiles, requestCameraPermission]);

  const pickDocuments = useCallback(async () => {
    const result = await DocumentPicker.getDocumentAsync({
      type:     '*/*',
      multiple: true,
      copyToCacheDirectory: true,
    });

    if (result.canceled) return;

    addFiles(
      result.assets.map((a) => ({
        uri:      a.uri,
        name:     a.name,
        mimeType: a.mimeType ?? 'application/octet-stream',
        size:     a.size ?? 0,
      })),
    );
  }, [addFiles]);

  // ── Upload a single file ──────────────────────────────────────────────────

  const uploadOne = useCallback((file: UploadFile): Promise<void> => {
    return new Promise((resolve) => {
      const service = getBucketUploadService();
      const startTime = Date.now();

      patchFile(file.id, { status: 'uploading', startedAt: startTime });

      const handle = service.startUpload(
        file.uri,
        file.name,
        file.mimeType,
        // onProgress
        (percent) => {
          patchFile(file.id, {
            progress:   percent,
            elapsedSec: Math.round((Date.now() - startTime) / 1000),
          });
        },
        // onStatus
        (status, remoteUrl, error) => {
          if (status === 'done') {
            patchFile(file.id, { status: 'done', progress: 100, remoteUrl });
          } else {
            patchFile(file.id, { status: 'error', error });
          }
          handlesRef.current.delete(file.id);
          resolve();
        },
      );

      handlesRef.current.set(file.id, handle);
    });
  }, [patchFile]);

  // ── Upload all pending (concurrency-limited) ──────────────────────────────

  const uploadAll = useCallback(async () => {
    if (files.some((f) => f.status === 'uploading')) return;

    const pending = files.filter((f) => f.status === 'pending' || f.status === 'error');
    if (pending.length === 0) return;

    let cursor = 0;
    const run = async (): Promise<void> => {
      if (cursor >= pending.length) return;
      const file = pending[cursor++];
      await uploadOne(file);
      await run(); // chain next
    };

    const workers = Array.from(
      { length: Math.min(MAX_CONCURRENCY, pending.length) },
      () => run(),
    );
    
    // Fire-and-forget workers
    Promise.all(workers).catch((err) => {
      console.error('Upload worker pool error:', err);
    });
  }, [files, uploadOne]);

  // ── Retry single upload ───────────────────────────────────────────────────

  const retryUpload = useCallback((id: string) => {
    setFiles((prev) => {
      const file = prev.find((f) => f.id === id);
      if (!file) return prev;

      const startTime = Date.now();
      const resetFile = {
        ...file,
        status: 'uploading' as const,
        progress: 0,
        startedAt: startTime,
        error: undefined,
      };

      uploadOne(resetFile);

      return prev.map((f) => (f.id === id ? resetFile : f));
    });
  }, [uploadOne]);

  // ── Cancel ────────────────────────────────────────────────────────────────

  const cancelUpload = useCallback((id: string) => {
    handlesRef.current.get(id)?.cancel();
    handlesRef.current.delete(id);
    patchFile(id, { status: 'cancelled', progress: 0 });
  }, [patchFile]);

  // ── Remove / clear ────────────────────────────────────────────────────────

  const removeFile = useCallback((id: string) => {
    handlesRef.current.get(id)?.cancel();
    handlesRef.current.delete(id);
    setFiles((prev) => prev.filter((f) => f.id !== id));
  }, []);

  const clearDone = useCallback(() => {
    setFiles((prev) => prev.filter((f) => f.status !== 'done' && f.status !== 'cancelled'));
  }, []);

  const clearAll = useCallback(() => {
    // Cancel all active uploads
    handlesRef.current.forEach((h) => h.cancel());
    handlesRef.current.clear();
    setFiles([]);
  }, []);

  // ── Derived stats ─────────────────────────────────────────────────────────

  const isUploading = files.some((f) => f.status === 'uploading');

  const stats = {
    total:      files.length,
    done:       files.filter((f) => f.status === 'done').length,
    failed:     files.filter((f) => f.status === 'error').length,
    pending:    files.filter((f) => f.status === 'pending').length,
    uploading:  files.filter((f) => f.status === 'uploading').length,
    totalBytes: files.reduce((s, f) => s + f.size, 0),
    doneBytes:  files.filter((f) => f.status === 'done').reduce((s, f) => s + f.size, 0),
  };

  return {
    files,
    pickImages,
    pickFromCamera,
    pickDocuments,
    uploadAll,
    cancelUpload,
    removeFile,
    clearDone,
    clearAll,
    retryUpload,
    isUploading,
    stats,
  };
}
