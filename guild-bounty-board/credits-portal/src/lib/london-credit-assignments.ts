// Static fallback for redeem flow when Firestore is empty. Keep empty in repo;
// load real assignments via Firestore or a gitignored local override file.

export type LondonCreditAssignment = {
  attendeeId: string;
  projectId: string;
  name: string;
  email: string;
  cursorUrl: string;
  code: string;
};

export const LONDON_CREDIT_ASSIGNMENTS: LondonCreditAssignment[] = [];
