import { createHash } from 'node:crypto';
import { z } from 'zod';
import ical, { ICalEventStatus } from 'ical-generator';
import type { Profile } from './config.js';
import { vault, type Vault } from './vault.js';
import { LmsError } from './errors.js';

const instant = z.string().datetime({ offset: true });
export const ItemInput = z.object({
  id: z.string().min(1).max(200).describe('Stable source/semantic ID; never use the due date as identity.'),
  title: z.string().min(1).max(300),
  kind: z.enum(['assignment', 'exam', 'class', 'reading', 'other']),
  course: z.string().max(200).optional(),
  start: instant.nullable().optional(), end: instant.nullable().optional(), due: instant.nullable().optional(),
  status: z.enum(['open', 'done', 'cancelled']).optional(),
  needsConfirmation: z.boolean().optional(),
  notes: z.string().max(4000).optional(),
  sources: z.array(z.object({ url: z.string().url().refine(s => new URL(s).protocol === 'https:'), quote: z.string().min(1).max(6000), publishedAt: instant.optional() }).strict()).min(1).max(20),
}).strict().refine(v => !(v.start && v.end) || Date.parse(v.end) > Date.parse(v.start), 'end must be later than start');
export type Item = z.infer<typeof ItemInput> & { updatedAt: string; history: Array<{ at: string; title: string; start?: string | null; end?: string | null; due?: string | null; sources: z.infer<typeof ItemInput>['sources'] }> };
export async function listItems(p: Profile, store: Vault = vault): Promise<Item[]> { return (await store.read<Item[]>(p, 'items'))?.value ?? []; }
export async function upsertItems(p: Profile, inputs: unknown, store: Vault = vault) {
  const parsed = z.array(ItemInput).min(1).max(100).safeParse(inputs);
  if (!parsed.success) throw new LmsError('BAD_INPUT', parsed.error.issues.map(e => `${e.path.join('.')}: ${e.message}`).join('; '));
  return store.update<Item[]>(p, 'items', old => {
    const rows = new Map((old ?? []).map(r => [r.id, r]));
    for (const input of parsed.data) {
      const previous = rows.get(input.id); const updatedAt = new Date().toISOString();
      const provided = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as typeof input;
      const next = { ...previous, ...provided, status: input.status ?? previous?.status ?? 'open', needsConfirmation: input.needsConfirmation ?? previous?.needsConfirmation ?? false, updatedAt, history: previous?.history ?? [] };
      if (previous && JSON.stringify([previous.title, previous.start, previous.end, previous.due, previous.sources]) !== JSON.stringify([next.title, next.start, next.end, next.due, next.sources])) {
        next.history = [...previous.history, { at: previous.updatedAt, title: previous.title, start: previous.start, end: previous.end, due: previous.due, sources: previous.sources }].slice(-20);
      }
      rows.set(input.id, next);
    }
    return [...rows.values()];
  });
}
export function exportCalendar(p: Profile, items: Item[]) {
  const calendar = ical({ name: `${p.label} · LMS`, prodId: '//lms-cli//Canvas Blackboard CLI//EN' });
  const excluded: string[] = [];
  for (const item of items) {
    const time = item.start ?? item.due;
    if (!time || item.needsConfirmation) { excluded.push(item.id); continue; }
    calendar.createEvent({ id: `${createHash('sha256').update(`${p.id}:${item.id}`).digest('hex')}@lms-cli`,
      start: new Date(time), ...(item.end && item.start ? { end: new Date(item.end) } : {}),
      summary: item.title, description: [item.course, item.notes, ...item.sources.map(s => `${s.quote}\n${s.url}`)].filter(Boolean).join('\n\n'),
      status: item.status === 'cancelled' ? ICalEventStatus.CANCELLED : ICalEventStatus.CONFIRMED,
      lastModified: new Date(item.updatedAt), sequence: item.history.length, url: item.sources[0]?.url,
    });
  }
  return { ics: calendar.toString(), excluded, note: 'Only explicitly timed, confirmed items are exported. UTC instants preserve the school timezone without guessing missing times. Import clients differ in update/cancellation behavior.' };
}
