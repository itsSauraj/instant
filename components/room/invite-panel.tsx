"use client";

import { Link2, QrCode } from "lucide-react";

import { CopyField } from "@/components/copy-field";
import { QrInvite } from "@/components/room/qr-invite";
import { prettyRoomId } from "@/lib/ids";
import type { RoomVisibility } from "@/lib/signal-protocol";

/**
 * The invite surface for the right-hand drawer: the same link/code/QR trio
 * the lobby shows, available at any point in the session. Content only; the
 * drawer shell (title, close, scrim) is `SidePanel`.
 */
export function InvitePanel({
  roomId,
  inviteUrl,
  visibility,
}: {
  roomId: string;
  inviteUrl: string;
  visibility: RoomVisibility;
}) {
  return (
    <div className="space-y-3 text-left">
      <p className="text-muted-foreground text-xs">
        {visibility === "public"
          ? "Anyone who opens this link joins straight away while a seat is free."
          : "People who open this link ask to join; the host lets each one in by name."}
      </p>

      <div>
        <p className="text-muted-foreground mb-1 flex items-center gap-1.5 text-xs font-medium">
          <Link2 className="size-3.5" />
          Invite link
        </p>
        <CopyField value={inviteUrl} label="Copy invite link" />
      </div>
      <div>
        <p className="text-muted-foreground mb-1 text-xs font-medium">Or share the code</p>
        <CopyField value={prettyRoomId(roomId)} label="Copy session code" />
      </div>
      <div>
        <p className="text-muted-foreground mb-1.5 flex items-center gap-1.5 text-xs font-medium">
          <QrCode className="size-3.5" />
          Or scan it with a phone
        </p>
        {/* The drawer is 20rem wide with 1rem side padding; 168px leaves the
            quiet zone and the white backing comfortably inside it. */}
        <QrInvite url={inviteUrl} showUrl={false} size={168} />
      </div>
    </div>
  );
}
