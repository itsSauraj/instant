"use client";

import { Link2, Lock, QrCode, UserPlus } from "lucide-react";

import { CopyField } from "@/components/copy-field";
import { QrInvite } from "@/components/room/qr-invite";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { prettyRoomId } from "@/lib/ids";

/**
 * The invite surface as a header action: the same link/code/QR trio the
 * lobby shows, available at any point in the session.
 */
export function InviteDialog({ roomId, inviteUrl }: { roomId: string; inviteUrl: string }) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5">
          <UserPlus className="size-3.5" />
          <span className="hidden sm:inline">Invite</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Invite to this session</DialogTitle>
          <DialogDescription>
            Sessions hold exactly two people — the next person to open this link takes the free
            seat.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-left">
          <div>
            <p className="text-muted-foreground mb-1.5 flex items-center gap-1.5 text-xs font-medium">
              <Link2 className="size-3.5" />
              Invite link
            </p>
            <CopyField value={inviteUrl} label="Copy invite link" />
          </div>
          <div>
            <p className="text-muted-foreground mb-1.5 text-xs font-medium">Or share the code</p>
            <CopyField value={prettyRoomId(roomId)} label="Copy session code" />
          </div>
          <div>
            <p className="text-muted-foreground mb-2 flex items-center gap-1.5 text-xs font-medium">
              <QrCode className="size-3.5" />
              Or scan it with a phone
            </p>
            <QrInvite url={inviteUrl} showUrl={false} />
          </div>
        </div>

        <Badge variant="muted" className="mx-auto gap-1.5 py-1">
          <Lock />
          Only the next person to open this link can join
        </Badge>
      </DialogContent>
    </Dialog>
  );
}
