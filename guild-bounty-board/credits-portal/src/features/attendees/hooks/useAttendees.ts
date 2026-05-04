/**
 * Hook for fetching and managing attendee data
 *
 * Redemption name suggestions: checked-in guests only (hasCheckedIn from API).
 * Ops may pre-assign codes (hasRedeemed); those names still appear in the picker.
 */

import { useState, useEffect } from 'react';

export interface AttendeeForSuggestion {
  id: string;
  name: string;
  email: string;
  projectId?: string;
  hasRedeemed: boolean;
  /** From API: only checked-in guests are eligible for the redeem name picker */
  hasCheckedIn?: boolean;
}

export function useAttendees(projectId?: string) {
  const [attendees, setAttendees] = useState<AttendeeForSuggestion[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchAttendees();
  }, [projectId]);

  const fetchAttendees = async () => {
    try {
      setIsLoading(true);
      const url = projectId ? `/credits/api/attendees?projectId=${projectId}` : '/credits/api/attendees';
      const response = await fetch(url);
      
      if (!response.ok) {
        throw new Error('Failed to fetch attendees');
      }
      
      const data = await response.json();
      setAttendees(data.attendees || []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load attendees');
      console.error('Error fetching attendees:', err);
    } finally {
      setIsLoading(false);
    }
  };

  /** Checked-in or already assigned guests. Fallback to all rows if the API has legacy check-in flags. */
  const eligibleAttendees = attendees.filter(
    (a) => a.hasCheckedIn !== false || a.hasRedeemed
  );
  const redeemSearchPool =
    eligibleAttendees.length > 0 ? eligibleAttendees : attendees;

  // Find attendee by exact name match (checked-in pool so ops pre-assign does not hide names)
  const findAttendeeByName = (name: string): AttendeeForSuggestion | null => {
    const trimmedName = name.trim();
    return redeemSearchPool.find(
      attendee => attendee.name.toLowerCase() === trimmedName.toLowerCase()
    ) || null;
  };

  // Get name suggestions based on partial input (matches any word in the search against any part of the name)
  const getNameSuggestions = (input: string): AttendeeForSuggestion[] => {
    if (!input || input.length < 1) return [];

    const searchWords = input.toLowerCase().trim().split(/\s+/).filter(w => w.length > 0);
    return redeemSearchPool
      .filter(attendee => {
        const name = attendee.name.toLowerCase();
        return searchWords.every(word => name.includes(word));
      })
      .slice(0, 10);
  };

  return {
    attendees,
    isLoading,
    error,
    findAttendeeByName,
    getNameSuggestions,
    refetch: fetchAttendees,
  };
}
