"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useGSAP } from "@gsap/react";
import { ArrowRight, FileUp, Lock, StickyNote, Users, Video } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { DURATION, EASE, gsap, prefersReducedMotion, revealIn } from "@/lib/animation";
import { createRoomId, isValidRoomId, normalizeRoomId } from "@/lib/ids";

const CAPABILITIES = [
  {
    icon: StickyNote,
    title: "Notes",
    description: "Type back and forth over a reliable, ordered data channel.",
  },
  {
    icon: FileUp,
    title: "Files",
    description: "Drag in anything. Chunked straight to the other browser.",
  },
  {
    icon: Video,
    title: "Audio & video",
    description: "Camera, microphone and screen share on the same connection.",
  },
] as const;

export function HomeHero() {
  const router = useRouter();
  const scope = useRef<HTMLDivElement>(null);
  const orbRef = useRef<HTMLDivElement>(null);
  const [joinCode, setJoinCode] = useState("");
  const [joinError, setJoinError] = useState<string | null>(null);

  useGSAP(
    () => {
      revealIn(scope.current, { stagger: 0.06, y: 18 });

      if (orbRef.current && !prefersReducedMotion()) {
        // Slow breathing halo behind the hero — the one continuous motion on the
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

  const createSession = () => {
    router.push(`/room/${createRoomId()}`);
  };

  const join = (event: React.FormEvent) => {
    event.preventDefault();
    const id = normalizeRoomId(joinCode);

    if (!id) {
      setJoinError("Paste an invite link or session code.");
      return;
    }
    if (!isValidRoomId(id)) {
      setJoinError("That doesn't look like a valid session code.");
      shake();
      return;
    }
    setJoinError(null);
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
            Two people. One connection. Nothing in between.
          </span>

          <h1
            data-anim="in"
            className="max-w-2xl text-4xl font-semibold tracking-tight text-balance sm:text-5xl"
          >
            Share notes, files and video{" "}
            <span className="text-primary">browser to browser</span>
          </h1>

          <p data-anim="in" className="text-muted-foreground max-w-xl text-pretty sm:text-lg">
            A session links exactly two browsers. Your data travels directly between them — the
            server only introduces the pair, then steps out.
          </p>
        </div>
      </div>

      <div data-anim="in" className="panel mx-auto w-full max-w-xl p-6 sm:p-7">
        <Button size="lg" className="w-full gap-2" onClick={createSession}>
          Create a private session
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
              className="font-mono"
            />
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
              Codes look like <span className="font-mono">k3f9-mq2t-8xbv-7rn0</span>
            </p>
          )}
        </form>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        {CAPABILITIES.map(({ icon: Icon, title, description }) => (
          <div key={title} data-anim="in" className="panel p-5">
            <Icon className="text-primary size-5" />
            <h2 className="mt-3 text-sm font-semibold">{title}</h2>
            <p className="text-muted-foreground mt-1 text-sm">{description}</p>
          </div>
        ))}
      </div>

      <p
        data-anim="in"
        className="text-muted-foreground mx-auto flex max-w-lg items-start gap-2.5 text-center text-xs"
      >
        <Lock className="mt-0.5 size-3.5 shrink-0" />
        <span className="text-left">
          A session seals after the second person joins — a third can never get in. When either
          side leaves, the session is destroyed for both and cannot be resumed.
        </span>
      </p>
    </div>
  );
}
