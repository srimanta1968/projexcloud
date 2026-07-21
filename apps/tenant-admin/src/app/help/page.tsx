import { readFile } from 'fs/promises';
import path from 'path';

/**
 * Reads the canonical guide from public/docs/, scopes its CSS to a wrapper
 * class so it doesn't bleed into the console layout, and renders it inline
 * so the nav bar + breadcrumb stay visible above it.
 */
async function loadGuide(): Promise<{ style: string; body: string }> {
  const file = path.join(process.cwd(), 'public', 'docs', 'tenant-admin-guide.html');
  const html = await readFile(file, 'utf8');
  const styleMatch = html.match(/<style[^>]*>([\s\S]*?)<\/style>/i);
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const rawStyle = styleMatch?.[1] ?? '';
  const scoped = rawStyle
    .replace(/(^|\})\s*body\s*\{/g, '$1 .doc-page-root {')
    .replace(/(^|\})\s*\*\s*\{/g, '$1 .doc-page-root *, .doc-page-root {');
  return { style: scoped, body: bodyMatch?.[1] ?? '' };
}

export default async function HelpPage(): Promise<JSX.Element> {
  const { style, body } = await loadGuide();
  // Static docs live under public/docs/; prefix with the portal basePath so the
  // links resolve when the console is mounted under a path (e.g. /tenant).
  const base = process.env.NEXT_PUBLIC_BASE_PATH ?? '';
  return (
    <>
      <section className="mb-6 rounded-lg border border-border bg-muted/40 p-4">
        <div className="text-sm font-semibold">Developer resources</div>
        <p className="mt-1 text-[13px] text-muted-foreground">
          Full REST reference for every SDK — endpoints, auth, payloads, field options,
          error responses and status transitions.
        </p>
        <div className="mt-3 flex flex-wrap gap-4 text-sm">
          <a
            href={`${base}/docs/api/index.html`}
            target="_blank"
            rel="noreferrer"
            className="text-primary underline"
          >
            API reference ↗
          </a>
          <a
            href={`${base}/docs/api/test-plan.html`}
            target="_blank"
            rel="noreferrer"
            className="text-primary underline"
          >
            API test plan ↗
          </a>
        </div>
      </section>
      <style dangerouslySetInnerHTML={{ __html: style }} />
      <div className="doc-page-root" dangerouslySetInnerHTML={{ __html: body }} />
    </>
  );
}
