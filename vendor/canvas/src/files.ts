import { canvasGet, canvasGetPaginated, baseUrl } from './canvas.js';
import { htmlToText } from './html.js';

/** Files navigation may be disabled while individual module-linked files remain accessible. */
export async function listCourseFiles(courseId: number, search?: string) {
  try {
    const { items, truncated } = await canvasGetPaginated(`/courses/${courseId}/files`, {
      search_term: search, sort: 'updated_at', order: 'desc',
    });
    return { rows: items.map((f: any) => ({ id: f.id, filename: f.display_name, content_type: f['content-type'],
      size_kb: Math.round((f.size ?? 0) / 1024), updated_at: f.updated_at })),
      note: truncated ? 'NOTE: file listing truncated; narrow the search.' : undefined };
  } catch (error) {
    if (!/Canvas API 403\b/.test(String(error))) throw error;
  }
  const notes = ['Files listing returned 403. These are file references from accessible course content, not a complete file inventory.'];
  const files = new Map<number, { id: number; filename: string; discovered_by: string }>();
  const pages = new Set<string>();
  const add = (id: unknown, title: string, source: string) => {
    if (typeof id === 'number' && Number.isSafeInteger(id) && id > 0 && !files.has(id)) files.set(id, { id, filename: title, discovered_by: source });
  };
  let modulesRead = false;
  try {
    const modules = await canvasGetPaginated(`/courses/${courseId}/modules`, { 'include[]': ['items'] });
    modulesRead = true;
    if (modules.truncated) notes.push('Module list truncated.');
    for (const m of modules.items as any[]) {
      let items = m.items ?? [];
      if (m.items_count > items.length) {
        const result = await canvasGetPaginated(`/courses/${courseId}/modules/${m.id}/items`);
        items = result.items;
        if (result.truncated) notes.push('Module items truncated.');
      }
      for (const item of items) {
        if (item.type === 'File') add(item.content_id, item.title ?? `Canvas file ${item.content_id}`, 'module');
        if (item.type === 'Page' && item.page_url) pages.add(item.page_url);
      }
    }
  } catch (error) {
    if (/expired|AUTH_REQUIRED|401/i.test(String(error))) throw error;
    notes.push('Module references unavailable.');
  }
  // Read a small bounded sample of linked pages; never follow external links or crawl attachments.
  if (!pages.size && !files.size) {
    try {
      const listed = await canvasGetPaginated(`/courses/${courseId}/pages`, { per_page: 10 }, 1);
      for (const p of listed.items as any[]) if (p.url) pages.add(p.url);
      if (listed.truncated) notes.push('Page list truncated.');
    } catch (error) {
      if (/expired|AUTH_REQUIRED|401/i.test(String(error))) throw error;
      notes.push('Page listing unavailable.');
    }
  }
  if (pages.size > 5) notes.push(`Only the first 5 of ${pages.size} page references were inspected.`);
  let pagesRead = false;
  for (const slug of [...pages].slice(0, 5)) {
    try {
      const page = await canvasGet(`/courses/${courseId}/pages/${encodeURIComponent(slug)}`);
      pagesRead = true;
      const body = String(page.body ?? '');
      for (const match of body.matchAll(/(?:href|data-api-endpoint)\s*=\s*["']([^"']+)["']/gi)) {
        let url: URL;
        try { url = new URL(match[1]!.replace(/&amp;/g, '&'), baseUrl()); } catch { continue; }
        if (url.origin !== new URL(baseUrl()).origin) continue;
        const file = url.pathname.match(new RegExp(`^/(?:api/v1/)?(?:courses/${courseId}/)?files/(\\d+)(?:/|$)`));
        if (file) {
          const remaining = body.slice((match.index ?? 0) + match[0].length);
          const label = remaining.match(/^[^>]*>([\s\S]*?)<\/a>/i)?.[1];
          add(Number(file[1]), label ? htmlToText(label, 200) : `Canvas file ${file[1]}`, `page:${slug}`);
        }
      }
    } catch (error) {
      if (/expired|AUTH_REQUIRED|401/i.test(String(error))) throw error;
      notes.push('A linked page could not be read.');
    }
  }
  if (!modulesRead && !pagesRead) throw new Error('403: Course file listing and fallback sources are unavailable.');
  const rows = [...files.values()].filter(f => !search || f.filename.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  if (search) notes.push('Fallback search matches module titles and page link labels; some filenames may not be discoverable.');
  return { rows, note: notes.join(' ') };
}
