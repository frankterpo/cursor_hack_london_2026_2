// Example shape for emergency static fallback data (never commit real codes or PII).
// Copy to london-credit-assignments.local.ts and gitignored, or load via Firestore instead.

export type LondonCreditAssignment = {
  attendeeId: string;
  projectId: string;
  name: string;
  email: string;
  cursorUrl: string;
  code: string;
};

export const LONDON_CREDIT_ASSIGNMENTS_EXAMPLE: LondonCreditAssignment[] = [
  {
    attendeeId: 'example-attendee-id',
    projectId: 'your-firestore-project-id',
    name: 'Example Guest',
    email: 'guest@example.com',
    cursorUrl: 'https://cursor.com/referral?code=EXAMPLE',
    code: 'EXAMPLE',
  },
];
