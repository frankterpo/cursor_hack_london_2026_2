/**
 * Whether an attendee record has a real Luma / ops check-in marker.
 * Supports both normalized Firestore fields and raw Luma CSV/API shapes.
 */
export function hasMeaningfulCheckedIn(data: Record<string, unknown>): boolean {
  if (
    data.hasCheckedIn === true ||
    data.checkedIn === true ||
    data.isCheckedIn === true ||
    data.checked_in === true
  ) {
    return true;
  }

  const c =
    data.checkedInAt ??
    data.checked_in_at ??
    data.checkedInAtIso ??
    data.checkedInTime;
  if (c == null || c === "") return false;
  if (
    typeof c === "object" &&
    c !== null &&
    "toDate" in c &&
    typeof (c as { toDate: () => Date }).toDate === "function"
  ) {
    const d = (c as { toDate: () => Date }).toDate();
    if (!d || Number.isNaN(d.getTime())) return false;
    return d.getFullYear() >= 1900;
  }
  if (typeof c === "string") {
    const trimmed = c.trim();
    if (!trimmed || trimmed.startsWith("0001")) return false;
    if (["false", "no", "null", "undefined"].includes(trimmed.toLowerCase()))
      return false;
    return trimmed.length > 4;
  }
  return Boolean(c);
}
