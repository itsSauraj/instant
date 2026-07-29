"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import type { VariantProps } from "class-variance-authority";

import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * A confirmation dialog for consequential actions, built on the already
 * installed @radix-ui/react-dialog (there is no alert-dialog package here).
 *
 * It differs from `dialog.tsx` deliberately:
 *  - `role="alertdialog"`, so screen readers announce it as needing a decision;
 *  - no corner X and no dismissal by clicking outside — the only ways out are
 *    the explicit Cancel and Action buttons (Escape still cancels);
 *  - initial focus lands on Cancel, so Enter never triggers the destructive
 *    action by accident.
 *
 * Radix wires `aria-labelledby`/`aria-describedby` from Title and Description
 * automatically, so every AlertDialogContent must contain both.
 */

function AlertDialog(props: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="alert-dialog" {...props} />;
}

function AlertDialogTrigger(props: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="alert-dialog-trigger" {...props} />;
}

function AlertDialogContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content>) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay
        data-slot="alert-dialog-overlay"
        className="data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/60 backdrop-blur-sm"
      />
      <DialogPrimitive.Content
        data-slot="alert-dialog-content"
        role="alertdialog"
        onOpenAutoFocus={(event) => {
          // Focus the safe way out first. Radix would otherwise focus the
          // first tabbable element, which is Cancel anyway in our footer
          // order — but make it explicit rather than positional.
          const cancel = (event.currentTarget as HTMLElement | null)?.querySelector<HTMLElement>(
            '[data-slot="alert-dialog-cancel"]',
          );
          if (cancel) {
            event.preventDefault();
            cancel.focus();
          }
        }}
        // A confirmation must be answered, not dismissed by a stray click.
        onPointerDownOutside={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
        className={cn(
          "panel data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 fixed top-1/2 left-1/2 z-50 grid w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 gap-4 p-6 shadow-lg duration-200",
          className,
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

function AlertDialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div data-slot="alert-dialog-header" className={cn("grid gap-1.5", className)} {...props} />
  );
}

function AlertDialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-dialog-footer"
      className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)}
      {...props}
    />
  );
}

function AlertDialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="alert-dialog-title"
      className={cn("text-base leading-none font-semibold", className)}
      {...props}
    />
  );
}

function AlertDialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="alert-dialog-description"
      className={cn("text-muted-foreground text-sm", className)}
      {...props}
    />
  );
}

/**
 * Confirms the action and closes. Defaults to the destructive look because
 * this primitive exists for consequential choices; pass `variant` to soften.
 */
function AlertDialogAction({
  className,
  variant = "destructive",
  ...props
}: React.ComponentProps<typeof Button> & VariantProps<typeof buttonVariants>) {
  return (
    <DialogPrimitive.Close asChild>
      <Button data-slot="alert-dialog-action" variant={variant} className={className} {...props} />
    </DialogPrimitive.Close>
  );
}

/** Declines and closes. Receives initial focus (see AlertDialogContent). */
function AlertDialogCancel({ className, ...props }: React.ComponentProps<typeof Button>) {
  return (
    <DialogPrimitive.Close asChild>
      <Button data-slot="alert-dialog-cancel" variant="outline" className={className} {...props} />
    </DialogPrimitive.Close>
  );
}

export {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
};
