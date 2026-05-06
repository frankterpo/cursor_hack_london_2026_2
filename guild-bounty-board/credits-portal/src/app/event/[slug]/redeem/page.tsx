import { redirect } from "next/navigation";

/** Canonical redemption is always `/redeem` (slug comes from env). Legacy URLs redirect here. */
export default function LegacySlugRedeemPage() {
  redirect("/redeem");
}
