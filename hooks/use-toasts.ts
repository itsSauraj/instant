"use client";

import { useSyncExternalStore } from "react";

/**
 * A minimal toast store, shaped like lib/peer-session.ts: a module-level
 * external store read through useSyncExternalStore. `pushToast` is therefore
 * callable from anywhere — event handlers, the session store, other hooks —
 * without a context provider in the way.
 */

export type ToastVariant = "info" | "success" | "warning" | "error";

export type Toast = {
  id: number;
  title: string;
  description?: string;
  variant: ToastVariant;
  /** True while the exit animation plays; removal follows shortly after. */
  leaving: boolean;
};

export type ToastInput = {
  title: string;
  description?: string;
  variant?: ToastVariant;
  /** Auto-dismiss delay. Defaults per variant; errors linger longest. */
  durationMs?: number;
};

/** Most toasts visible at once; older ones are pushed out early. */
export const MAX_VISIBLE_TOASTS = 4;

/** How long the UI gets to animate a leaving toast before it is dropped. */
export const TOAST_EXIT_MS = 260;

const DEFAULT_DURATION: Record<ToastVariant, number> = {
  info: 4500,
  success: 4500,
  warning: 6000,
  error: 8000,
};

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();

const EMPTY: Toast[] = [];
const getServerToasts = () => EMPTY;

function emit() {
  for (const listener of listeners) listener();
}

function setTimer(id: number, ms: number, run: () => void) {
  clearTimer(id);
  timers.set(id, setTimeout(run, ms));
}

function clearTimer(id: number) {
  const timer = timers.get(id);
  if (timer) clearTimeout(timer);
  timers.delete(id);
}

/** Hard removal, after the exit animation has had its chance. */
function remove(id: number) {
  clearTimer(id);
  if (!toasts.some((toast) => toast.id === id)) return;
  toasts = toasts.filter((toast) => toast.id !== id);
  emit();
}

/**
 * Begins a toast's exit: it is flagged `leaving` so the view can animate it
 * out, then removed unconditionally a beat later (the store must never depend
 * on the animation actually running).
 */
export function dismissToast(id: number) {
  const toast = toasts.find((entry) => entry.id === id);
  if (!toast || toast.leaving) return;
  toasts = toasts.map((entry) => (entry.id === id ? { ...entry, leaving: true } : entry));
  emit();
  setTimer(id, TOAST_EXIT_MS, () => remove(id));
}

/** Shows a toast. Returns its id so callers can dismiss it early. */
export function pushToast(input: ToastInput): number {
  const variant = input.variant ?? "info";
  const id = nextId++;
  const toast: Toast = {
    id,
    title: input.title,
    description: input.description,
    variant,
    leaving: false,
  };

  // Cap the stack: evict the oldest still-visible toast rather than letting
  // notifications wallpaper the screen.
  const visible = toasts.filter((entry) => !entry.leaving);
  if (visible.length >= MAX_VISIBLE_TOASTS) {
    dismissToast(visible[0].id);
  }

  toasts = [...toasts, toast];
  emit();
  setTimer(id, input.durationMs ?? DEFAULT_DURATION[variant], () => dismissToast(id));
  return id;
}

export function subscribeToasts(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getToasts(): Toast[] {
  return toasts;
}

/** React binding; the viewport component is the only expected consumer. */
export function useToasts(): Toast[] {
  return useSyncExternalStore(subscribeToasts, getToasts, getServerToasts);
}
