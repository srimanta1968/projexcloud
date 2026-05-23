import { FastifyInstance } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';

/**
 * hdk-image-editor — TS facade for native image editor (crop / rotate /
 * markup / filters). Native modules live in iOS Swift (Core Image) and
 * Android Kotlin (GPUImage); this surface exposes capability discovery
 * + server-side metadata routes.
 */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/hdk/image-editor/capabilities', { preHandler: requireAuth }, async () => {
    return {
      data: {
        tools: ['crop', 'rotate', 'flip', 'markup', 'text', 'blur', 'sharpen', 'filter'],
        filters: ['mono', 'sepia', 'vivid', 'noir', 'fade'],
        output_formats: ['jpeg', 'png', 'heic'],
        native_modules: { ios: 'ProjexImageEditor.framework', android: 'projex-image-editor.aar' },
      },
    };
  });
}
