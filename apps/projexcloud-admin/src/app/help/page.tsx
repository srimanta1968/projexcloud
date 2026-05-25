import { readFile } from 'fs/promises';
import path from 'path';

/**
 * Reads the canonical guide from public/docs/, scopes its CSS to a wrapper
 * class so it doesn't bleed into the console layout, and renders it inline
 * so the nav bar + breadcrumb stay visible above it.
 */
async function loadGuide(): Promise<{ style: string; body: string }> {
  const file = path.join(process.cwd(), 'public', 'docs', 'platform-admin-guide.html');
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
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: style }} />
      <div className="doc-page-root" dangerouslySetInnerHTML={{ __html: body }} />
    </>
  );
}
