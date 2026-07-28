import { notFound } from "next/navigation";

import { RoomClient } from "@/components/room/room-client";
import { isValidRoomId, normalizeRoomId } from "@/lib/ids";

export const metadata = {
  title: "Instant | Session",
  // Invite links carry the session id, so keep them out of search results.
  robots: { index: false, follow: false },
};

export default async function RoomPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const roomId = normalizeRoomId(id);

  if (!isValidRoomId(roomId)) notFound();

  return <RoomClient roomId={roomId} />;
}
