export type HackathonJudge = { name: string; title?: string };
export type HackathonPartnerLink = { label: string; href: string };

/** Visual skin for `/` only — OG Cursor routes stay unchanged. */
export type HackathonSkin = "default" | "thrad";

export type HackathonLandingConfig = {
  title: string;
  subtitle?: string;
  tracks?: string[];
  judges?: HackathonJudge[];
  prizes?: string[];
  partnerLinks?: HackathonPartnerLink[];
  skin?: HackathonSkin;
};

function splitLines(s?: string): string[] | undefined {
  if (!s?.trim()) return undefined;
  const lines = s.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  return lines.length ? lines : undefined;
}

function parseJson<T>(raw?: string): T | undefined {
  if (!raw?.trim()) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function parseSkin(raw?: string): HackathonSkin | undefined {
  const v = raw?.trim().toLowerCase();
  if (v === "thrad") return "thrad";
  if (v === "default") return "default";
  return undefined;
}

/** Env-driven copy for `/` — keeps partner/event theming off standard credits routes. */
export function getHackathonLandingConfig(): HackathonLandingConfig {
  const fromJson = parseJson<Partial<HackathonLandingConfig & { skin?: string }>>(
    process.env.NEXT_PUBLIC_HACKATHON_LANDING_JSON,
  );
  if (fromJson && typeof fromJson.title === "string" && fromJson.title.trim()) {
    return {
      title: fromJson.title.trim(),
      subtitle: fromJson.subtitle?.trim(),
      tracks: fromJson.tracks,
      judges: fromJson.judges,
      prizes: fromJson.prizes,
      partnerLinks: fromJson.partnerLinks,
      skin:
        parseSkin(typeof fromJson.skin === "string" ? fromJson.skin : undefined) ??
        parseSkin(process.env.NEXT_PUBLIC_HACKATHON_SKIN) ??
        "default",
    };
  }

  const judges =
    parseJson<HackathonJudge[]>(process.env.NEXT_PUBLIC_HACKATHON_JUDGES_JSON) ||
    splitLines(process.env.NEXT_PUBLIC_HACKATHON_JUDGES)?.map((name) => ({ name }));

  return {
    title:
      process.env.NEXT_PUBLIC_HACKATHON_TITLE?.trim() ||
      "Hackathon",
    subtitle: process.env.NEXT_PUBLIC_HACKATHON_SUBTITLE?.trim(),
    tracks:
      parseJson<string[]>(process.env.NEXT_PUBLIC_HACKATHON_TRACKS_JSON) ||
      splitLines(process.env.NEXT_PUBLIC_HACKATHON_TRACKS),
    judges,
    prizes:
      parseJson<string[]>(process.env.NEXT_PUBLIC_HACKATHON_PRIZES_JSON) ||
      splitLines(process.env.NEXT_PUBLIC_HACKATHON_PRIZES),
    partnerLinks: parseJson<HackathonPartnerLink[]>(
      process.env.NEXT_PUBLIC_HACKATHON_PARTNER_LINKS_JSON,
    ),
    skin: parseSkin(process.env.NEXT_PUBLIC_HACKATHON_SKIN) ?? "default",
  };
}
