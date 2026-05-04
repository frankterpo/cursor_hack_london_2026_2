/**
 * Mirrors src/lib/csv-parser.ts parseCodesCSV for Node scripts (no TS build).
 */

function extractCodeFromUrl(csvLine) {
  try {
    const parts = csvLine.split(",");
    const urlPart = parts[0];
    if (!urlPart.includes("cursor.com/referral?code=")) return null;
    const url = new URL(urlPart);
    return url.searchParams.get("code");
  } catch {
    return null;
  }
}

function parseCodesCSV(csvContent) {
  const lines = csvContent.split("\n").map((l) => l.trim()).filter(Boolean);
  const codes = [];
  for (const line of lines) {
    const comma = line.indexOf(",");
    if (comma < 0) continue;
    const left = line.slice(0, comma).trim();
    const right = line.slice(comma + 1).trim();

    if (/^code$/i.test(left) && /^url$/i.test(right)) continue;

    if (right.includes("cursor.com/referral?code=") && left.length > 0) {
      if (!left.startsWith("http")) {
        codes.push({
          code: left,
          cursorUrl: right,
          creator: undefined,
          date: undefined,
        });
        continue;
      }
    }

    const parts = line.split(",");
    const cursorUrl = parts[0]?.trim();
    const creator = parts[1]?.trim();
    const date = parts[2]?.trim();
    if (cursorUrl && cursorUrl.includes("cursor.com/referral?code=")) {
      const code = extractCodeFromUrl(line);
      if (code) codes.push({ code, cursorUrl, creator, date });
    }
  }
  return codes;
}

module.exports = { parseCodesCSV };
