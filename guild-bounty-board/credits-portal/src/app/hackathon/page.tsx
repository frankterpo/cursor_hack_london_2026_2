import { redirect } from "next/navigation";

/** Canonical thematic landing is `/` per deploy; keep `/hackathon` as a permanent alias. */
export default function HackathonAliasPage() {
  redirect("/");
}
