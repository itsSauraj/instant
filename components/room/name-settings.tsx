"use client";

import { useEffect, useState } from "react";
import { Check, UserRound } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { sanitizeName } from "@/lib/identity";
import { SIGNAL_LIMITS } from "@/lib/signal-protocol";

/**
 * The "Your name" section of the Settings pane. Saving tells the room, which
 * confirms through the roster; the form is keyed on the confirmed name, so it
 * resets to whatever the room actually holds and never drifts from it.
 */
export function NameSettings({
  name,
  onRename,
}: {
  /** The name the room currently holds for this person. */
  name: string;
  onRename: (name: string) => void;
}) {
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // "Saved" is a receipt, not a state: it fades after a moment.
  useEffect(() => {
    if (savedAt === null) return;
    const timer = window.setTimeout(() => setSavedAt(null), 2500);
    return () => window.clearTimeout(timer);
  }, [savedAt]);

  return (
    <section aria-label="Your name" className="space-y-2">
      <div className="space-y-1">
        <p className="text-sm font-medium">Your name</p>
        <p className="text-muted-foreground text-xs">
          Shown on your tile, in the participants list and on the notes you send from now on.
          Notes you already sent keep the name they were sent under.
        </p>
      </div>
      <NameForm
        key={name}
        name={name}
        onSave={(next) => {
          onRename(next);
          setSavedAt(Date.now());
        }}
      />
      {savedAt !== null ? (
        <p role="status" className="text-success flex items-center gap-1 text-xs">
          <Check className="size-3.5" aria-hidden />
          Saved. Everyone sees the new name.
        </p>
      ) : null}
    </section>
  );
}

function NameForm({ name, onSave }: { name: string; onSave: (name: string) => void }) {
  const [draft, setDraft] = useState(name);
  const clean = sanitizeName(draft);
  const unchanged = clean === name;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!clean || unchanged) return;
        onSave(clean);
      }}
      className="space-y-1"
    >
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <UserRound
            aria-hidden
            className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2"
          />
          <Input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            maxLength={SIGNAL_LIMITS.maxNameLength}
            aria-label="Your name"
            autoComplete="name"
            spellCheck={false}
            className="h-8 pl-8 text-sm"
          />
        </div>
        <Button type="submit" size="sm" disabled={!clean || unchanged}>
          Save
        </Button>
      </div>
      {!clean && draft.length > 0 ? (
        <p className="text-warning text-xs">A name needs at least one visible character.</p>
      ) : null}
    </form>
  );
}
