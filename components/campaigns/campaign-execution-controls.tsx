"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { PauseIcon, PlayIcon, SquareIcon } from "lucide-react";

import { pauseCampaignAction, resumeCampaignAction, stopCampaignAction } from "@/app/(app)/campaigns/[campaignId]/actions";
import { unwrapActionResult } from "@/lib/action-result";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// Pause/Resume/Stop for a launched campaign. Draft campaigns don't render
// this at all (see the campaign detail page) — "Start" lives in the setup
// wizard's Review step, which already runs the same readiness check (see
// lib/campaigns/readiness.ts) before calling launchCampaignAction.
export function CampaignExecutionControls({
  campaignId,
  campaignStatus,
}: {
  campaignId: string;
  campaignStatus: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [stopOpen, setStopOpen] = useState(false);

  function handlePause() {
    startTransition(async () => {
      try {
        unwrapActionResult(await pauseCampaignAction(campaignId));
        toast.success("Campaign paused.");
        router.refresh();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Couldn't pause the campaign.");
      }
    });
  }

  function handleResume() {
    startTransition(async () => {
      try {
        unwrapActionResult(await resumeCampaignAction(campaignId));
        toast.success("Campaign resumed.");
        router.refresh();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Couldn't resume the campaign.");
      }
    });
  }

  function handleStop() {
    startTransition(async () => {
      try {
        unwrapActionResult(await stopCampaignAction(campaignId));
        toast.success("Campaign stopped.");
        setStopOpen(false);
        router.refresh();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Couldn't stop the campaign.");
      }
    });
  }

  if (campaignStatus === "completed") return null;

  return (
    <>
      <div className="flex items-center gap-2">
        {campaignStatus === "active" && (
          <Button variant="outline" size="sm" onClick={handlePause} disabled={isPending}>
            <PauseIcon />
            Pause
          </Button>
        )}
        {campaignStatus === "paused" && (
          <Button variant="outline" size="sm" onClick={handleResume} disabled={isPending}>
            <PlayIcon />
            Resume
          </Button>
        )}
        {(campaignStatus === "active" || campaignStatus === "paused") && (
          <Button variant="outline" size="sm" onClick={() => setStopOpen(true)} disabled={isPending}>
            <SquareIcon />
            Stop
          </Button>
        )}
      </div>

      <Dialog open={stopOpen} onOpenChange={setStopOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Stop this campaign?</DialogTitle>
            <DialogDescription>
              This ends the campaign and cancels every lead still waiting to be sent to. This can&apos;t be undone —
              start a new campaign to reach these leads again.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setStopOpen(false)} disabled={isPending}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleStop} disabled={isPending}>
              {isPending ? "Stopping…" : "Stop campaign"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
