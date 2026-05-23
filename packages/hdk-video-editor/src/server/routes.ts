import { FastifyInstance } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';

/**
 * hdk-video-editor — TS facade for native video editor (trim / merge /
 * captions / mute). Native modules live in iOS Swift (AVFoundation) and
 * Android Kotlin (ExoPlayer + Media3 Transformer); this surface exposes
 * capability discovery + transcode-job hand-off endpoints.
 */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/hdk/video-editor/capabilities', { preHandler: requireAuth }, async () => {
    return {
      data: {
        tools: ['trim', 'merge', 'caption', 'mute', 'speed', 'overlay'],
        output_formats: ['mp4', 'hevc', 'webm'],
        max_resolution: '4K',
        native_modules: { ios: 'ProjexVideoEditor.framework', android: 'projex-video-editor.aar' },
      },
    };
  });
}
