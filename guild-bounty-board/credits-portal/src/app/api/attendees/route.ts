import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/firebase';
import { collection, getDocs } from 'firebase/firestore';
import { hasMeaningfulCheckedIn } from '@/lib/attendee-checked-in';
import { LONDON_CREDIT_ASSIGNMENTS } from '@/lib/london-credit-assignments';
import { getProjectAttendees } from '@/lib/attendee-cache';

const LONDON_2026_FIRESTORE_PROJECT_ID = 'nynsjuhYRTQhxTNZgywQ';

interface PublicAttendee {
  id: string;
  name: string;
  email: string;
  projectId: string | null;
  hasRedeemed: boolean;
  hasCheckedIn: boolean;
}

/**
 * Module-level response cache: the rendered JSON-shaped list per projectId.
 * Reused across keystrokes/tabs on the same warm lambda; 30s TTL is plenty
 * for an in-person event and matches the underlying attendee snapshot cache.
 */
const responseCache = new Map<string, { at: number; rows: PublicAttendee[] }>();
const RESPONSE_TTL_MS = 30_000;

/**
 * Public API route for fetching attendees during redemption flow
 * This is separate from the admin attendees API and handles the public redemption process
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    let projectId = searchParams.get('projectId');
    
    // For MVP compatibility: if no projectId provided, try to fetch legacy data first
    if (!projectId) {
      // First try to fetch from the old structure (for existing data without projectId)
      try {
        const legacyAttendeesSnapshot = await getDocs(collection(db, 'attendees'));
        const legacyAttendees = legacyAttendeesSnapshot.docs
          .filter((doc) => !doc.data().projectId) // Only get truly legacy data (no projectId field)
          .map((doc) => {
            const data = doc.data();
            return {
              id: doc.id,
              name: data.name,
              email: data.email,
              projectId: data.projectId || null,
              hasRedeemed: data.hasRedeemedCode || false,
              hasCheckedIn:
                hasMeaningfulCheckedIn(data as Record<string, unknown>) ||
                !!data.hasRedeemedCode,
            };
          })
          .filter(attendee => attendee.name && attendee.email);

        if (legacyAttendees.length > 0) {
          return NextResponse.json({ 
            success: true, 
            attendees: legacyAttendees 
          });
        }
      } catch {
        // If legacy fetch fails, continue with project-based approach
      }
      
      // If no legacy data found, use default projectId
      projectId = 'sample-event-1';
    }

    const cached = responseCache.get(projectId);
    if (cached && Date.now() - cached.at < RESPONSE_TTL_MS) {
      return NextResponse.json({ success: true, attendees: cached.rows });
    }

    let snapshot = await getProjectAttendees(projectId);
    if (snapshot.rows.length === 0 && projectId !== LONDON_2026_FIRESTORE_PROJECT_ID) {
      snapshot = await getProjectAttendees(LONDON_2026_FIRESTORE_PROJECT_ID);
    }

    if (snapshot.rows.length === 0) {
      const rows: PublicAttendee[] = LONDON_CREDIT_ASSIGNMENTS.map(
        (attendee) => ({
          id: attendee.attendeeId,
          name: attendee.name,
          email: attendee.email,
          projectId: attendee.projectId,
          hasRedeemed: Boolean(attendee.cursorUrl || attendee.code),
          hasCheckedIn: true,
        })
      );
      responseCache.set(projectId, { at: Date.now(), rows });
      return NextResponse.json({ success: true, attendees: rows });
    }

    const attendees: PublicAttendee[] = snapshot.rows
      .map((row) => {
        const data = row.data;
        return {
          id: row.id,
          name: String(data.name ?? ''),
          email: String(data.email ?? ''),
          projectId: String(data.projectId ?? projectId),
          hasRedeemed: Boolean(data.hasRedeemedCode),
          hasCheckedIn:
            hasMeaningfulCheckedIn(data) || Boolean(data.hasRedeemedCode),
        };
      })
      .filter((attendee) => attendee.name && attendee.email);

    responseCache.set(projectId, { at: Date.now(), rows: attendees });
    return NextResponse.json({ success: true, attendees });
  } catch (error) {
    console.error('Public attendees API error:', error);
    return NextResponse.json(
      { 
        success: false, 
        error: 'Failed to fetch attendees',
        attendees: []
      },
      { status: 500 }
    );
  }
}
