import { FastifyInstance } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';

/**
 * hdk-camera — TS facade for native camera capture (still + video + RAW).
 *
 * Native modules: iOS Swift (AVFoundation), Android Kotlin (CameraX).
 * This TS surface exposes capability discovery, recording preset metadata,
 * and an upload-target negotiation helper that returns a sdk-media signed
 * URL appropriate for the caller's tenant.
 */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/hdk/camera/capabilities', { preHandler: requireAuth }, async () => {
    return {
      data: {
        photo_formats: ['jpeg', 'heic', 'raw_dng'],
        video_codecs: ['h264', 'hevc', 'av1'],
        max_photo_resolution: '48MP',
        max_video_resolution: '4K@60',
        flash: true,
        depth_sensor: true,
        ocr_passthrough: true,
        native_modules: {
          ios: 'ProjexCameraKit.framework',
          android: 'projex-camera.aar',
        },
      },
    };
  });

  app.get('/api/hdk/camera/recording-presets', { preHandler: requireAuth }, async () => {
    return {
      data: {
        presets: [
          { name: 'standard',  width: 1920, height: 1080, fps: 30, codec: 'h264' },
          { name: 'high',      width: 3840, height: 2160, fps: 30, codec: 'hevc' },
          { name: 'slow-mo',   width: 1920, height: 1080, fps: 240, codec: 'h264' },
          { name: 'time-lapse', width: 3840, height: 2160, fps: 1, codec: 'hevc' },
        ],
      },
    };
  });
}
