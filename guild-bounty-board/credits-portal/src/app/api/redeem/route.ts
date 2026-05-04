/**
 * API route for code redemption
 * 
 * Handles the core business logic for validating attendee information
 * and assigning available codes from the database.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/firebase';
import {
  collection,
  query,
  where,
  getDocs,
  runTransaction,
  doc,
  limit,
} from 'firebase/firestore';
import type { QueryDocumentSnapshot, DocumentData } from 'firebase/firestore';
import { AttendeeRedemptionSchema } from '@/features/attendees/model';
import type { ApiResponse } from '@/lib/types';
import { LONDON_CREDIT_ASSIGNMENTS } from '@/lib/london-credit-assignments';

function normEmail(em: string) {
  return em.trim().toLowerCase();
}

function findStaticAssignment(nameInput: string, emailInput: string) {
  const wantName = nameInput.trim().toLowerCase();
  const wantEmail = normEmail(emailInput);
  return LONDON_CREDIT_ASSIGNMENTS.find(
    (row) =>
      row.name.trim().toLowerCase() === wantName &&
      normEmail(row.email) === wantEmail
  );
}

async function findRedemptionForAttendee(
  projectId: string,
  attendeeId: string,
  name: string,
  email: string
) {
  const byId = await getDocs(
    query(
      collection(db, 'redemptions'),
      where('projectId', '==', projectId),
      where('attendeeId', '==', attendeeId),
      limit(1)
    )
  );
  if (!byId.empty) return byId;

  const wantE = normEmail(email);
  const wantN = name.trim().toLowerCase();
  const pool = await getDocs(
    query(collection(db, 'redemptions'), where('projectId', '==', projectId))
  );
  const hit = pool.docs.find((d) => {
    const x = d.data();
    return (
      normEmail(String(x.attendeeEmail || '')) === wantE &&
      String(x.attendeeName || '')
        .trim()
        .toLowerCase() === wantN
    );
  });
  if (hit) {
    return {
      empty: false,
      docs: [hit],
    } as Awaited<ReturnType<typeof getDocs>>;
  }

  if (projectId === 'sample-event-1') {
    return await getDocs(
      query(
        collection(db, 'redemptions'),
        where('attendeeName', '==', name.trim()),
        where('attendeeEmail', '==', email.toLowerCase().trim())
      )
    );
  }

  return byId;
}

/**
 * POST /api/redeem
 *
 * Redeems a code for a validated attendee.
 * Expects attendee to be pre-validated through the validation endpoint.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    // Validate input data
    const validatedData = AttendeeRedemptionSchema.parse(body);

    // Handle backward compatibility: use eventId if projectId not provided
    const projectId = validatedData.projectId || validatedData.eventId || 'sample-event-1';

    // Final validation: check attendee exists and hasn't redeemed
    const attendeesRef = collection(db, 'attendees');
    let attendeeQuery = query(
      attendeesRef,
      where('projectId', '==', projectId),
      where('name', '==', validatedData.name.trim()),
      where('email', '==', validatedData.email.toLowerCase().trim())
    );

    let attendeeSnapshot = await getDocs(attendeeQuery);

    // Only fall back to legacy query if we're specifically dealing with legacy eventId
    if (
      attendeeSnapshot.empty &&
      projectId === 'sample-event-1' &&
      !validatedData.projectId &&
      validatedData.eventId === 'sample-event-1'
    ) {
      attendeeQuery = query(
        attendeesRef,
        where('name', '==', validatedData.name.trim()),
        where('email', '==', validatedData.email.toLowerCase().trim())
      );
      attendeeSnapshot = await getDocs(attendeeQuery);
    }

    let attendeeDoc: QueryDocumentSnapshot<DocumentData> | undefined;

    if (!attendeeSnapshot.empty) {
      attendeeDoc = attendeeSnapshot.docs[0];
    } else {
      const all = await getDocs(
        query(attendeesRef, where('projectId', '==', projectId))
      );
      const wantN = validatedData.name.trim().toLowerCase();
      const wantE = normEmail(validatedData.email);
      attendeeDoc = all.docs.find((d) => {
        const x = d.data();
        return (
          String(x.name || '')
            .trim()
            .toLowerCase() === wantN &&
          normEmail(String(x.email || '')) === wantE
        );
      });
    }

    if (!attendeeDoc) {
      const staticAssignment = findStaticAssignment(
        validatedData.name,
        validatedData.email
      );
      if (staticAssignment?.cursorUrl) {
        const response: ApiResponse = {
          success: true,
          data: {
            code: staticAssignment.code,
            cursorUrl: staticAssignment.cursorUrl,
            name: staticAssignment.name,
            email: staticAssignment.email,
            redemptionId: `static-${staticAssignment.attendeeId}`,
            fromStaticFallback: true,
          },
          timestamp: new Date(),
        };
        return NextResponse.json(response);
      }

      const response: ApiResponse = {
        success: false,
        error: 'Attendee not found. Please validate your information first.',
        timestamp: new Date(),
      };
      return NextResponse.json(response, { status: 404 });
    }

    const existingRedemptionSnapshot = await findRedemptionForAttendee(
      projectId,
      attendeeDoc.id,
      validatedData.name,
      validatedData.email
    );

    if (!existingRedemptionSnapshot.empty) {
      const red = existingRedemptionSnapshot.docs[0].data() as Record<
        string,
        unknown
      >;
      const cursorUrl = String(red.codeUrl || red.cursorUrl || '');
      const codeVal = String(red.codeValue || red.code || '');
      const response: ApiResponse = {
        success: true,
        data: {
          code: codeVal,
          cursorUrl: cursorUrl || undefined,
          name: validatedData.name,
          email: validatedData.email,
          redemptionId: existingRedemptionSnapshot.docs[0].id,
          fromPriorAssignment: true,
        },
        timestamp: new Date(),
      };
      return NextResponse.json(response);
    }
    
    // Get available code
    const codesRef = collection(db, 'codes');
    let availableCodesQuery = query(
      codesRef,
      where('projectId', '==', projectId),
      where('isRedeemed', '==', false)
    );
    
    let availableCodesSnapshot = await getDocs(availableCodesQuery);
    
    // Only fall back to legacy codes if we're specifically dealing with legacy eventId
    if (availableCodesSnapshot.empty && 
        projectId === 'sample-event-1' && 
        !validatedData.projectId && 
        validatedData.eventId === 'sample-event-1') {
      availableCodesQuery = query(
        codesRef,
        where('isRedeemed', '==', false)
      );
      availableCodesSnapshot = await getDocs(availableCodesQuery);
    }
    
    console.log(`Found ${availableCodesSnapshot.size} available codes`);
    
    if (availableCodesSnapshot.empty) {
      // Check total codes for better error message
      const allCodesSnapshot = await getDocs(collection(db, 'codes'));
      const totalCodes = allCodesSnapshot.size;
      
      console.log(`Total codes in database: ${totalCodes}`);
      
      const errorMessage = totalCodes === 0 
        ? 'No codes have been uploaded yet. Please contact an administrator.'
        : 'All codes have been redeemed. Please contact an administrator for more codes.';
      
      const response: ApiResponse = {
        success: false,
        error: errorMessage,
        timestamp: new Date(),
      };
      return NextResponse.json(response, { status: 503 });
    }
    
    // Get the first available code
    const codeDoc = availableCodesSnapshot.docs[0];
    const codeData = codeDoc.data();
    
    // Use transaction to ensure atomicity
    const result = await runTransaction(db, async (transaction) => {
      // Mark code as redeemed
      transaction.update(doc(db, 'codes', codeDoc.id), {
        isRedeemed: true,
        redeemedBy: attendeeDoc.id,
        redeemedAt: new Date(),
      });
      
      // Update attendee record to mark as redeemed (CRITICAL: prevents double redemption)
      transaction.update(doc(db, 'attendees', attendeeDoc.id), {
        hasRedeemedCode: true,
        redeemedCodeId: codeDoc.id,
        redeemedAt: new Date(),
      });
      
      // Create redemption record (must use transaction.set inside transaction)
      const redemptionRef = doc(collection(db, 'redemptions'));
      const redemptionData = {
        projectId: projectId,
        attendeeName: validatedData.name.trim(),
        attendeeEmail: validatedData.email.toLowerCase().trim(),
        attendeeId: attendeeDoc.id,
        codeId: codeDoc.id,
        codeValue: codeData.code,
        codeUrl: codeData.cursorUrl,
        redeemedAt: new Date(),
        timestamp: new Date(), // Keep for backward compatibility
        ipAddress: request.headers.get('x-forwarded-for') || 
                   request.headers.get('x-real-ip') || 
                   'unknown',
        userAgent: request.headers.get('user-agent') || 'unknown',
      };
      
      transaction.set(redemptionRef, redemptionData);
      
      return {
        code: codeData.code,
        cursorUrl: codeData.cursorUrl,
        attendeeId: attendeeDoc.id,
        redemptionId: redemptionRef.id,
      };
    });
    
    const response: ApiResponse = {
      success: true,
      data: {
        code: result.code,
        cursorUrl: result.cursorUrl,
        name: validatedData.name,
        email: validatedData.email,
        redemptionId: result.redemptionId,
      },
      timestamp: new Date(),
    };
    
    return NextResponse.json(response);
    
  } catch (error) {
    console.error('Redemption error:', error);
    
    const response: ApiResponse = {
      success: false,
      error: error instanceof Error ? error.message : 'Redemption failed',
      timestamp: new Date(),
    };
    
    return NextResponse.json(response, { status: 500 });
  }
}
