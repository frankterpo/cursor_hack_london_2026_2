/**
 * Module-level cache of attendees per project. Reused across requests on the
 * same warm lambda so /api/attendees and /api/attendees/validate don't pay
 * the cost of reading the full collection on every keystroke and click.
 *
 * Reads are stale-tolerant — a 30s TTL is plenty for an in-person event, and
 * the redeem route still hits Firestore live for the transactional update.
 */

import { collection, getDocs, query, where } from 'firebase/firestore';
import type { DocumentData, QueryDocumentSnapshot } from 'firebase/firestore';
import { db } from './firebase';

export interface CachedAttendee {
  id: string;
  data: Record<string, unknown>;
  /** Lower-cased canonical for fast lookup */
  nameKey: string;
  emailKey: string;
}

interface ProjectCache {
  loadedAt: number;
  rows: CachedAttendee[];
  byNameEmail: Map<string, CachedAttendee>;
  byName: Map<string, CachedAttendee[]>;
}

const TTL_MS = 30_000;
const cache = new Map<string, ProjectCache>();
const inflight = new Map<string, Promise<ProjectCache>>();

function normName(s: unknown): string {
  return String(s ?? '').trim().toLowerCase();
}

function normEmail(s: unknown): string {
  return String(s ?? '').trim().toLowerCase();
}

function buildIndex(rows: CachedAttendee[]): ProjectCache {
  const byNameEmail = new Map<string, CachedAttendee>();
  const byName = new Map<string, CachedAttendee[]>();
  for (const row of rows) {
    if (row.nameKey && row.emailKey) {
      byNameEmail.set(`${row.nameKey}|${row.emailKey}`, row);
    }
    if (row.nameKey) {
      const list = byName.get(row.nameKey) ?? [];
      list.push(row);
      byName.set(row.nameKey, list);
    }
  }
  return { loadedAt: Date.now(), rows, byNameEmail, byName };
}

async function loadProject(projectId: string): Promise<ProjectCache> {
  const snap = await getDocs(
    query(collection(db, 'attendees'), where('projectId', '==', projectId))
  );
  const rows: CachedAttendee[] = snap.docs.map(
    (d: QueryDocumentSnapshot<DocumentData>) => {
      const data = d.data() as Record<string, unknown>;
      return {
        id: d.id,
        data,
        nameKey: normName(data.name),
        emailKey: normEmail(data.email),
      };
    }
  );
  return buildIndex(rows);
}

export async function getProjectAttendees(
  projectId: string,
  opts: { force?: boolean } = {}
): Promise<ProjectCache> {
  const existing = cache.get(projectId);
  if (
    !opts.force &&
    existing &&
    Date.now() - existing.loadedAt < TTL_MS
  ) {
    return existing;
  }
  const pending = inflight.get(projectId);
  if (pending) return pending;
  const p = loadProject(projectId)
    .then((c) => {
      cache.set(projectId, c);
      return c;
    })
    .finally(() => {
      inflight.delete(projectId);
    });
  inflight.set(projectId, p);
  return p;
}

export function findAttendeeInCache(
  c: ProjectCache,
  name: string,
  email?: string | null
): CachedAttendee | null {
  const nk = normName(name);
  if (!nk) return null;
  if (email) {
    const ek = normEmail(email);
    return c.byNameEmail.get(`${nk}|${ek}`) ?? null;
  }
  const hits = c.byName.get(nk);
  return hits && hits.length > 0 ? hits[0] : null;
}

export function invalidateProject(projectId: string) {
  cache.delete(projectId);
}
