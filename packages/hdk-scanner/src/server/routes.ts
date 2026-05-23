import { FastifyInstance } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';

/**
 * hdk-scanner — TS facade for native barcode/QR/document scanner modules.
 *
 * The actual scanner UI lives in iOS Swift (AVFoundation + Vision) and
 * Android Kotlin (CameraX + ML Kit) modules consumed by hdk-foundation
 * apps. This TS surface only documents and provides server-side metadata
 * endpoints (capability discovery, supported formats, settings) so JS
 * code can negotiate scanner availability without touching native code.
 */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/hdk/scanner/capabilities', { preHandler: requireAuth }, async () => {
    return {
      data: {
        supported_formats: ['qr_code', 'pdf_417', 'code_128', 'ean_13', 'data_matrix'],
        document_detection: true,
        ocr: true,
        native_modules: { ios: 'ProjexScannerKit.framework', android: 'projex-scanner.aar' },
      },
    };
  });
}
