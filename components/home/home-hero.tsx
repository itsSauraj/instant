"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useGSAP } from "@gsap/react";
import { ArrowRight, Lock, Users } from "lucide-react";

import { MeshVisual } from "@/components/home/mesh-visual";
import { NameField } from "@/components/home/name-field";
import { ScanInvite } from "@/components/home/scan-invite";
import { VISIBILITY_COPY, VisibilityToggle } from "@/components/room/visibility-toggle";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { DURATION, EASE, gsap, prefersReducedMotion, revealIn } from "@/lib/animation";
import { getStoredName, markRoomCreated, setStoredName } from "@/lib/identity";
import { ROOM_CODE, createRoomId, isValidRoomId, normalizeRoomId } from "@/lib/ids";
import type { RoomVisibility } from "@/lib/signal-protocol";

export function HomeHero() {
  const router = useRouter();
  const scope = useRef<HTMLDivElement>(null);
  const orbRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const [joinCode, setJoinCode] = useState("");
  const [joinError, setJoinError] = useState<string | null>(null);
  const [name, setName] = useState("");
  // Private is the default on purpose: a public room's code is its only
  // barrier, so opening a room up should be a choice, never an accident.
  const [visibility, setVisibility] = useState<RoomVisibility>("private");
  // One soft nudge only: an empty name never blocks (the server substitutes a
  // placeholder), but the first attempt pauses to ask for one.
  const [nameNudged, setNameNudged] = useState(false);

  // Prefill after mount, not in the initial render: localStorage is absent on
  // the server, and reading it during hydration would mismatch the markup.
  useEffect(() => {
    setName(getStoredName());
  }, []);

  useGSAP(
    () => {
      revealIn(scope.current, { stagger: 0.06, y: 18 });

      if (orbRef.current && !prefersReducedMotion()) {
        // Slow breathing halo behind the hero - the one continuous motion on the
        // page, so it reads as ambient rather than as an animation.
        gsap.to(orbRef.current, {
          scale: 1.12,
          opacity: 0.75,
          duration: 4,
          ease: EASE.inOut,
          repeat: -1,
          yoyo: true,
        });
      }
    },
    { scope },
  );

  /**
   * The name travels to `/room/<id>` via localStorage (`lib/identity.ts`), not
   * a query parameter: room URLs are exactly what people copy, paste and scan
   * to invite each other, so anything in them is broadcast - and a recipient
   * opening `?name=Alice` would be misnamed after the sender. Storage keeps
   * the name private to this browser and alive across the reload that now
   * reclaims a session seat.
   *
   * Returns false when it nudged instead of proceeding.
   */
  const commitName = () => {
    const stored = setStoredName(name);
    if (!stored && !nameNudged) {
      setNameNudged(true);
      nameRef.current?.focus();
      return false;
    }
    return true;
  };

  const createSession = () => {
    if (!commitName()) return;
    const id = createRoomId();
    // Tells the room page this tab is the creator (and which kind of room they
    // asked for), so it seats them instead of asking for a name they just typed.
    markRoomCreated(id, visibility);
    router.push(`/room/${id}`);
  };

  /**
   * Also the way to start a session with a code of your own: a code nobody is
   * using founds a fresh room with whoever typed it as host, exactly as typing
   * `/room/<code>` into the address bar does.
   */
  const join = (event: React.FormEvent) => {
    event.preventDefault();
    const id = normalizeRoomId(joinCode);

    if (!id) {
      setJoinError("Paste an invite link or session code.");
      return;
    }
    if (!isValidRoomId(id)) {
      setJoinError(
        `Codes are ${ROOM_CODE.minLength} to ${ROOM_CODE.maxLength} letters and numbers.`,
      );
      shake();
      return;
    }
    setJoinError(null);
    if (!commitName()) return;
    router.push(`/room/${id}`);
  };

  const shake = () => {
    if (prefersReducedMotion()) return;
    gsap.fromTo(
      "[data-join-form]",
      { x: -6 },
      { x: 0, duration: DURATION.base, ease: "elastic.out(1, 0.35)" },
    );
  };

  return (
    <div ref={scope} className="flex flex-1 flex-col justify-center gap-10 py-12">
      <div className="relative">
        <div
          ref={orbRef}
          aria-hidden
          className="pointer-events-none absolute -top-28 left-1/2 size-[26rem] -translate-x-1/2 rounded-full bg-primary/20 opacity-50 blur-[90px]"
        />
        <div className="relative flex flex-col items-center gap-5 text-center">
          <span
            data-anim="in"
            className="border-primary/25 bg-primary/10 text-primary inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium"
          >
            <Users className="size-3.5" />
            Up to seven people. Direct connections. Nothing in between.
          </span>

          <h1
            data-anim="in"
            className="max-w-2xl text-4xl font-semibold tracking-tight text-balance sm:text-5xl"
          >
            Share notes, files and video{" "}
            <span className="text-primary">browser to browser</span>
          </h1>

          <p data-anim="in" className="text-muted-foreground max-w-xl text-pretty sm:text-lg">
            A session links up to seven browsers directly to each other. Your data travels
            peer to peer; the server only introduces people, then steps out.
          </p>
        </div>
      </div>

      {/* The page leads with the product itself: a live-looking session,
          before the form asks anyone to commit to anything. */}
      <div data-anim="in" className="mx-auto w-full max-w-2xl">
        <MeshVisual />
      </div>

      <div data-anim="in" className="panel mx-auto w-full max-w-xl p-6 sm:p-7">
        {/* One field serves both flows below it: whichever way you enter a
            room, this is the name the others will see. */}
        <NameField
          ref={nameRef}
          value={name}
          onChange={(next) => {
            setName(next);
            if (next.trim()) setNameNudged(false);
          }}
          nudge={nameNudged}
          className="mb-5"
        />

        {/* The kind of room is chosen BEFORE it exists, so the founding
            request carries it and nobody can slip in during the gap between
            "created" and "made private". The host can still flip it later. */}
        <div className="mb-3 space-y-1.5">
          <p className="text-muted-foreground text-xs font-medium">Who can join</p>
          <VisibilityToggle value={visibility} onChange={setVisibility} />
          <p
            // Live so a screen reader hears what the switch it just flipped means.
            aria-live="polite"
            className="text-muted-foreground text-xs"
          >
            {VISIBILITY_COPY[visibility].summary}
          </p>
        </div>

        <Button size="lg" className="w-full gap-2" onClick={createSession}>
          {visibility === "public" ? "Create a public session" : "Create a private session"}
          <ArrowRight className="size-4" />
        </Button>

        <div className="my-5 flex items-center gap-3">
          <Separator className="flex-1" />
          <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
            or join one
          </span>
          <Separator className="flex-1" />
        </div>

        <form data-join-form onSubmit={join} className="space-y-2">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Input
                value={joinCode}
                onChange={(event) => {
                  setJoinCode(event.target.value);
                  setJoinError(null);
                }}
                placeholder="Invite link or code"
                aria-label="Invite link or session code"
                aria-invalid={Boolean(joinError)}
                autoComplete="off"
                spellCheck={false}
                // Room for the scan button so a long code never runs under it.
                className="pr-10 font-mono"
              />
              <ScanInvite
                iconOnly
                className="absolute top-1/2 right-1 -translate-y-1/2"
                // A scan bypasses the join form's submit, so flush the typed
                // name to storage before the scanner navigates to the room.
                onBeforeNavigate={() => setStoredName(name)}
              />
            </div>
            <Button type="submit" variant="secondary">
              Join
            </Button>
          </div>
          {joinError ? (
            <p role="alert" className="text-destructive text-xs">
              {joinError}
            </p>
          ) : (
            <p className="text-muted-foreground text-xs">
              Paste a code, scan one with the camera icon, or type a code of your own to start a
              session with it
            </p>
          )}
        </form>
      </div>

      <p
        data-anim="in"
        className="text-muted-foreground mx-auto flex max-w-lg items-start gap-2.5 text-center text-xs"
      >
        <Lock className="mt-0.5 size-3.5 shrink-0" />
        <span className="text-left">
          In a private session nobody enters without the host letting them in; a public one
          admits anyone with the link. Either way the host sets how many seats exist, and
          closing the session destroys it for everyone.
        </span>
      </p>
    </div>
  );
}
