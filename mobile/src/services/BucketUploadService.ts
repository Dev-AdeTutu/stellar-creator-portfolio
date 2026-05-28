/**
 * BucketUploadService
 *
 * Uploads files directly to an external storage bucket (S3, R2, GCS, etc.)
 * via presigned PUT URLs — no backend bottleneck for the actual bytes.
 *
 * Flow:
 *  1. Call your own API to get a presigned PUT URL for the file.
 *  2. PUT the raw bytes directly to the bucket using XMLHttpRequest
 *     (XHR gives native byte-level onprogress; fetch does not in RN).
 *  3. On success, return the public read URL.
 *  4. On failure, retry with exponential backoff up to maxRetries.
 */

import { BucketUploadConfig, PresignResponse } from '../types';

// ─── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: Required<Omit<BucketUploadConfig, 'presignEndpoint' | 'authHeaders'>> = {
  concurrency: 2,
  maxRetries:  3,
  chunkSize:   5 * 1024 * 1024, // 5 MB
};

// ─── Progress callback ────────────────────────────────────────────────────────

export type ProgressCallback = (percent: number) => void;
export type StatusCallback   = (status: 'uploading' | 'done' | 'error', remoteUrl?: string, error?: string) => void;

// ─── Upload result ────────────────────────────────────────────────────────────

export interface UploadResult {
  success: boolean;
  remoteUrl?: string;
  error?: string;
}

// ─── Active upload handle (for cancellation) ──────────────────────────────────

export interface UploadHandle {
  cancel: () => void;
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class BucketUploadService {
  private readonly cfg: Required<BucketUploadConfig>;

  constructor(config: BucketUploadConfig) {
    this.cfg = {
      ...DEFAULT_CONFIG,
      authHeaders: {},
      ...config,
    };
  }

  // ── 1. Fetch a presigned URL from your server ──────────────────────────────

  private async fetchPresignedUrl(
    filename: string,
    mimeType: string,
  ): Promise<PresignResponse> {
    const params = new URLSearchParams({ filename, mimeType });
    const url    = `${this.cfg.presignEndpoint}?${params.toString()}`;

    const res = await fetch(url, {
      method:  'GET',
      headers: {
        'Content-Type': 'application/json',
        ...this.cfg.authHeaders,
      },
    });

    if (!res.ok) {
      throw new Error(`Presign failed: ${res.status} ${res.statusText}`);
    }

    const json = (await res.json()) as PresignResponse;

    if (!json.url || !json.publicUrl) {
      throw new Error('Invalid presign response: missing url or publicUrl');
    }

    return json;
  }

  // ── 2. PUT file bytes directly to bucket via XHR (progress events) ─────────

  private putToBucket(
    presignedUrl: string,
    fileUri:      string,
    mimeType:     string,
    onProgress:   ProgressCallback,
    signal:       AbortSignal,
  ): Promise<void> {
    return new Promise(async (resolve, reject) => {
      // Abort immediately if already cancelled
      if (signal.aborted) {
        reject(new Error('Upload cancelled'));
        return;
      }

      // Read file as ArrayBuffer using expo-file-system / fetch
      let body: Blob;
      try {
        const fileRes = await fetch(fileUri);
        body = await fileRes.blob();
      } catch (err) {
        reject(new Error(`Failed to read file: ${String(err)}`));
        return;
      }

      const xhr = new XMLHttpRequest();

      // Wire abort signal to XHR abort
      const onAbort = () => {
        xhr.abort();
        reject(new Error('Upload cancelled'));
      };
      signal.addEventListener('abort', onAbort, { once: true });

      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) {
          onProgress(Math.round((e.loaded / e.total) * 100));
        }
      });

      xhr.addEventListener('load', () => {
        signal.removeEventListener('abort', onAbort);
        // S3/R2/GCS return 200 or 204 on success
        if (xhr.status >= 200 && xhr.status < 300) {
          onProgress(100);
          resolve();
        } else {
          reject(new Error(`Bucket PUT failed: ${xhr.status}`));
        }
      });

      xhr.addEventListener('error', () => {
        signal.removeEventListener('abort', onAbort);
        reject(new Error('Network error during bucket PUT'));
      });

      xhr.addEventListener('timeout', () => {
        signal.removeEventListener('abort', onAbort);
        reject(new Error('Bucket PUT timed out'));
      });

      xhr.open('PUT', presignedUrl);
      xhr.setRequestHeader('Content-Type', mimeType);
      xhr.timeout = 5 * 60 * 1000; // 5-minute timeout per upload
      xhr.send(body);
    });
  }

  // ── 3. Single upload with retry ────────────────────────────────────────────

  async upload(
    fileUri:    string,
    filename:   string,
    mimeType:   string,
    onProgress: ProgressCallback,
    signal:     AbortSignal,
  ): Promise<UploadResult> {
    let attempt = 0;

    while (attempt < this.cfg.maxRetries) {
      if (signal.aborted) {
        return { success: false, error: 'Upload cancelled' };
      }

      try {
        // Step 1 — presign
        const { url: presignedUrl, publicUrl } = await this.fetchPresignedUrl(filename, mimeType);

        // Step 2 — PUT
        await this.putToBucket(presignedUrl, fileUri, mimeType, onProgress, signal);

        return { success: true, remoteUrl: publicUrl };
      } catch (err) {
        attempt++;
        const msg = String(err);

        // Don't retry cancellations
        if (msg.includes('cancelled') || signal.aborted) {
          return { success: false, error: 'Upload cancelled' };
        }

        if (attempt >= this.cfg.maxRetries) {
          return { success: false, error: `Upload failed after ${attempt} attempts: ${msg}` };
        }

        // Exponential backoff: 1s, 2s, 4s …
        const backoffMs = Math.pow(2, attempt - 1) * 1000;
        await new Promise((r) => setTimeout(r, backoffMs));
      }
    }

    return { success: false, error: 'Upload failed: max retries exceeded' };
  }

  // ── 4. Create a cancellable upload handle ──────────────────────────────────

  startUpload(
    fileUri:    string,
    filename:   string,
    mimeType:   string,
    onProgress: ProgressCallback,
    onStatus:   StatusCallback,
  ): UploadHandle {
    const controller = new AbortController();

    this.upload(fileUri, filename, mimeType, onProgress, controller.signal)
      .then((result) => {
        if (result.success) {
          onStatus('done', result.remoteUrl);
        } else {
          const isCancelled = result.error?.includes('cancelled');
          if (!isCancelled) {
            onStatus('error', undefined, result.error);
          }
        }
      })
      .catch((err) => {
        onStatus('error', undefined, String(err));
      });

    return {
      cancel: () => controller.abort(),
    };
  }
}

// ─── Singleton factory ────────────────────────────────────────────────────────

let _instance: BucketUploadService | null = null;

/**
 * Returns the app-wide BucketUploadService singleton.
 * Call configureBucketUpload() once at app startup before using this.
 */
export function getBucketUploadService(): BucketUploadService {
  if (!_instance) {
    // Default: points to the Next.js API route in the same project
    _instance = new BucketUploadService({
      presignEndpoint: 'https://your-api.example.com/api/upload/presign',
      concurrency:     2,
      maxRetries:      3,
    });
  }
  return _instance;
}

/**
 * Call once at app startup with real config (env vars, auth tokens, etc.)
 */
export function configureBucketUpload(config: BucketUploadConfig): void {
  _instance = new BucketUploadService(config);
}
