"use client";

import { CreditsPortalHeader } from "@/components/credits/CreditsPortalHeader";
import { boardPanelUrl } from "@/lib/credits-config";

type Panel = "submit" | "judge" | "manager";

const labels: Record<Panel, string> = {
  submit: "Submission panel",
  judge: "Judge panel",
  manager: "Hackathon manager",
};

export function BoardPanelFrame({ panel }: { panel: Panel }) {
  const src = boardPanelUrl(panel);

  return (
    <div className="flex min-h-screen flex-col pb-4">
      <CreditsPortalHeader />
      <div className="mx-auto flex w-full max-w-[1600px] flex-1 flex-col px-3 pt-3 sm:px-4">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{labels[panel]}</p>
          <a
            href={src}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs font-medium text-primary underline-offset-2 hover:underline"
          >
            Open guild board in new tab
          </a>
        </div>
        <div className="panel-event flex min-h-[calc(100vh-8rem)] flex-1 overflow-hidden p-0 sm:min-h-[560px]">
          <iframe title={labels[panel]} src={src} className="h-full min-h-[480px] w-full flex-1 border-0 bg-background" />
        </div>
      </div>
    </div>
  );
}
