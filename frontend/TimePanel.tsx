import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MapPin } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import type { IDockviewPanelProps } from "dockview";
import { createLogger } from "@/lib/logger";

const log = createLogger("TimePanel");

// Scan-line overlay shown on panels opened as a side effect of an LLM
// tool call. Two horizontal sweeps run during the 5s the panel is on
// screen (matching the chat-driven auto-close), plus a faint pulse on
// the border, so the user gets a clear "fresh from the model" cue.
// Injected as a singleton <style> so keyframes aren't duplicated when
// several scan overlays coexist.
function ScanOverlay() {
  useEffect(() => {
    if (document.getElementById("nnoel-time-panel-scan-keyframes")) return;
    const styleEl = document.createElement("style");
    styleEl.id = "nnoel-time-panel-scan-keyframes";
    styleEl.textContent = `
      /* Animate the top property (parent-relative) rather than
         transform: translateY, which would be relative to the line's
         own 32px height and only move it by that much. The line's top
         goes from -32px (off-screen above) to 100% (top edge at the
         parent's bottom; the rest is clipped by overflow-hidden). With
         animation-direction: alternate on the element, the line
         bounces top->bottom->top continuously. No opacity fade
         needed — the off-screen ends act as the natural fade. */
      @keyframes nnoel-scan-bounce {
        0%   { top: -32px; }
        100% { top: 100%; }
      }
    `;
    document.head.appendChild(styleEl);
    return () => {
      // Leave the keyframes in place if other scan overlays are still
      // mounted; only clean up on the last unmount.
      if (!document.querySelector("[data-nnoel-scan-overlay]")) {
        styleEl.remove();
      }
    };
  }, []);
  return (
    <div
      data-nnoel-scan-overlay
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 overflow-hidden"
    >
      {/* One horizontal scan line that bounces top->bottom->top
          continuously (alternate direction). The parent's
          overflow-hidden handles the natural fade-in/out at the
          edges — the line is fully off-screen above at top:-2rem
          and fully below at top:100%. Gradient + animation are
          inlined because the corresponding Tailwind utilities
          (bg-gradient-to-b, from-/via-/to-transparent,
          animate-[...]) aren't in the generated CSS for this
          plugin (the plugin lives outside the Vite root, so its
          file isn't picked up by Tailwind's source scanner). */}
      <div
        className="absolute right-0 h-8 w-full"
        style={{
          top: 0,
          background:
            "linear-gradient(to bottom, transparent, rgba(34, 211, 238, 0.35), transparent)",
          animation: "nnoel-scan-bounce 1.5s ease-in-out infinite alternate",
        }}
      />
    </div>
  );
}

interface TimeResult {
  text: string;
  // IANA timezone name (e.g. "Asia/Tokyo") or null for the host's local time.
  tz: string | null;
}

// Parameters this panel accepts from its creator / from
// ``api.updateParameters`` calls. The chat uses these to seed the panel
// when the LLM calls the get_local_time tool.
export interface TimePanelParameters {
  location?: string;
  text?: string;
  tz?: string | null;
  // True when the panel was opened as a side effect of an LLM tool
  // call (rather than directly from the taskbar). Triggers a scan
  // animation overlay that runs for the panel's visible lifetime.
  scan?: boolean;
}

// Matches a successful time string ("YYYY-MM-DD HH:MM:SS" or
// "YYYY-MM-DD HH:MM:SS TZ"). Anything else is treated as an error.
const TIME_RESULT = /^(\d{4})-(\d{2})-(\d{2}) \d{2}:\d{2}:\d{2}(?: [A-Z]+)?$/;

// Cap on the number of autocomplete suggestions rendered at once.
const MAX_SUGGESTIONS = 8;

// Format the current instant in the given IANA timezone (or the host's
// local zone when ``tz`` is null). Returns the date label, the time
// label, and the timezone abbreviation for display.
function formatInZone(date: Date, tz: string | null) {
  const timeZone = tz ?? undefined;
  const timeLabel = date.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone,
  });
  const dateLabel = date.toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone,
  });
  const tzAbbr = tz
    ? new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        timeZoneName: "short",
      })
        .formatToParts(date)
        .find((p) => p.type === "timeZoneName")?.value ?? null
    : new Intl.DateTimeFormat(undefined, {
        timeZoneName: "short",
      })
        .formatToParts(date)
        .find((p) => p.type === "timeZoneName")?.value ?? null;
  return { timeLabel, dateLabel, tzAbbr };
}

// Direct-invocation panel for the get_local_time tool. Lets the user call
// the tool without going through the LLM, returning the same result the
// model would have produced. When opened from the chat (via a tool call),
// ``api.getParameters()`` is pre-populated with the result and the panel
// renders it immediately without a round-trip.
export function TimePanel({ api, params }: IDockviewPanelProps<TimePanelParameters>) {
  // Read the seed parameters synchronously so the very first render
  // shows the right data — no empty-state flash before the effect runs.
  const seed = params;

  // What the user has typed so far. Updates on every keystroke.
  const [input, setInput] = useState(seed.location ?? "");
  // The location of the most recent *successful* tool call. Used as the
  // arg for the per-minute refetch so unsent keystrokes don't sneak in.
  const [submitted, setSubmitted] = useState(seed.location ?? "");
  const [result, setResult] = useState<TimeResult | null>(
    seed.text ? { text: seed.text, tz: seed.tz ?? null } : null,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Ticks every second so the displayed seconds stay in sync with the
  // wall clock without hitting the backend.
  const [, setTick] = useState(0);

  // Mirror of `submitted` so the per-minute refetch (which lives in a
  // mount-only effect) can always read the latest value without needing
  // to be torn down and recreated on every location change.
  const submittedRef = useRef(submitted);
  submittedRef.current = submitted;

  // Autocomplete state: full list fetched once on mount, the currently
  // highlighted suggestion index, and whether the dropdown is visible.
  const [locations, setLocations] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);

  async function callTime(loc: string) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/tools/get_local_time", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(loc ? { location: loc } : {}),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { result: string; extra?: { tz: string | null } };
      setResult({ text: data.result, tz: data.extra?.tz ?? null });
      setSubmitted(loc);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      log.error("get_local_time request failed", e, { location: loc });
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  // Drive the seconds tick. We use the real wall clock for "local" (tz is
  // null) and the resolved IANA zone for any other location.
  useEffect(() => {
    const id = setInterval(() => setTick((n) => (n + 1) % 1_000_000), 1000);
    return () => clearInterval(id);
  }, []);

  // Populate the result on mount and refetch on every minute boundary so
  // the timezone-relative seconds stay aligned with the server's clock
  // (and pick up DST transitions). The effect runs once on mount — the
  // user-typed input never triggers a refetch on its own. If the panel
  // was seeded with parameters (i.e. opened from a chat tool call),
  // skip the initial fetch — we already have the result.
  useEffect(() => {
    if (!result) {
      callTime("");
    }
    let timeoutId: number | undefined;
    function scheduleNext() {
      // Align to the top of the next minute so the displayed seconds
      // are always in sync with the server snapshot.
      const ms = 60_000 - (Date.now() % 60_000);
      timeoutId = window.setTimeout(() => {
        callTime(submittedRef.current);
        scheduleNext();
      }, ms);
    }
    scheduleNext();
    return () => {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When the chat updates this panel's parameters (because the LLM
  // called get_local_time again), reflect the new location and result
  // in the visible state. The per-minute refetch will pick up the new
  // ``submitted`` value on its next tick via ``submittedRef``.
  useEffect(() => {
    const disposable = api.onDidParametersChange((params) => {
      const loc = params.location ?? "";
      setInput(loc);
      setSubmitted(loc);
      if (params.text) {
        setResult({ text: params.text, tz: params.tz ?? null });
        setError(null);
      }
    });
    return () => disposable.dispose();
  }, [api]);

  // Fetch the full list of resolvable locations once, for the dropdown.
  useEffect(() => {
    let cancelled = false;
    fetch("/plugins/time/timezones/locations")
      .then((res) => res.json() as Promise<{ locations: string[] }>)
      .then((data) => {
        if (!cancelled) setLocations(data.locations);
      })
      .catch((err) =>
        log.warn(
          "Failed to fetch location suggestions; dropdown will be empty",
          err,
        ),
      );
    return () => {
      cancelled = true;
    };
  }, []);

  // Filter the location list to what's currently typed. Prefix matches
  // are surfaced first, then substring matches; case-insensitive. All
  // prefix matches are returned — the dropdown scrolls, so there's no
  // reason to hide relevant hits behind an arbitrary cap.
  const suggestions = useMemo(() => {
    const q = input.trim().toLowerCase();
    if (!q) return [];
    const prefix: string[] = [];
    const contains: string[] = [];
    for (const loc of locations) {
      const i = loc.indexOf(q);
      if (i < 0) continue;
      if (i === 0) prefix.push(loc);
      else if (contains.length < MAX_SUGGESTIONS) contains.push(loc);
    }
    return [...prefix, ...contains];
  }, [input, locations]);

  // Reset the highlight whenever the suggestion list shape changes.
  useEffect(() => {
    setHighlight(0);
  }, [suggestions]);

  function selectSuggestion(loc: string) {
    setInput(loc);
    setOpen(false);
    callTime(loc);
  }

  function submit() {
    setOpen(false);
    callTime(input.trim());
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (open && suggestions.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlight((h) => (h + 1) % suggestions.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlight((h) => (h - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        selectSuggestion(suggestions[highlight]);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  // Close the dropdown when the input loses focus, but allow the click
  // on a suggestion to register first (mousedown runs before blur).
  const inputWrapperRef = useRef<HTMLDivElement>(null);
  // Position of the input, used to place the portaled dropdown. We
  // re-measure on scroll/resize so the dropdown stays glued to the
  // input even as the panel or page scrolls around it.
  const [inputRect, setInputRect] = useState<DOMRect | null>(null);
  function onBlur(e: React.FocusEvent) {
    if (inputWrapperRef.current?.contains(e.relatedTarget as Node | null)) return;
    setOpen(false);
  }

  useLayoutEffect(() => {
    if (!open) return;
    const el = inputWrapperRef.current;
    if (!el) return;
    function update() {
      setInputRect(el?.getBoundingClientRect() ?? null);
    }
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, suggestions]);

  // Compute the current display from the live clock. If we don't have a
  // result yet (e.g. the first fetch is still in flight), fall back to
  // showing the host's local time so the card is never empty.
  const display = formatInZone(new Date(), result?.tz ?? null);
  const locationLabel = submitted || "Local";
  const tzAbbr = display.tzAbbr;
  const showDropdown = open && suggestions.length > 0 && inputRect !== null;

  // Dropdown placement. Default to extending below the input; if the
  // available room below is too small, flip above and clamp the height
  // to whatever fits in the viewport. A 4px gap separates the input
  // from the dropdown on either side.
  const DROPDOWN_GAP = 4;
  const VIEWPORT_MARGIN = 8;
  const desiredMaxHeight = 256;
  let dropdownStyle: React.CSSProperties | null = null;
  if (inputRect) {
    const spaceBelow = window.innerHeight - inputRect.bottom - VIEWPORT_MARGIN;
    const spaceAbove = inputRect.top - VIEWPORT_MARGIN;
    const flipAbove = spaceBelow < 160 && spaceAbove > spaceBelow;
    const maxHeight = Math.max(
      80,
      Math.min(
        desiredMaxHeight,
        flipAbove ? spaceAbove - DROPDOWN_GAP : spaceBelow - DROPDOWN_GAP,
      ),
    );
    dropdownStyle = flipAbove
      ? {
          position: "fixed",
          top: inputRect.top - DROPDOWN_GAP,
          left: inputRect.left,
          width: inputRect.width,
          maxHeight,
          transform: `translateY(-100%)`,
        }
      : {
          position: "fixed",
          top: inputRect.bottom + DROPDOWN_GAP,
          left: inputRect.left,
          width: inputRect.width,
          maxHeight,
        };
  }

  return (
    <div className="relative flex h-full flex-col overflow-hidden text-text-base">
      {/* Scan-line overlay: only present on panels opened as a side
          effect of an LLM tool call. Two horizontal sweeps run during
          the 5s the panel is on screen, plus a faint pulse on the
          border, so the user gets a clear "fresh from the model" cue. */}
      {seed.scan && <ScanOverlay />}

      <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div ref={inputWrapperRef} className="relative">
            <MapPin
              className="pointer-events-none absolute top-2.5 h-4 w-4 text-muted-fg"
              style={{ left: "0.625rem" }}
            />
            <Textarea
              className="min-h-10! pl-8"
              style={{ maxHeight: "8rem" }}
              placeholder="e.g. Tokyo, Japan, Europe… (empty = local time)"
              rows={1}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                setOpen(true);
              }}
              onFocus={() => setOpen(true)}
              onKeyDown={onKeyDown}
              onBlur={onBlur}
              disabled={loading}
              autoComplete="off"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={showDropdown}
              aria-controls="time-suggestions"
            />
          </div>
          {showDropdown && dropdownStyle &&
            createPortal(
              <ul
                id="time-suggestions"
                role="listbox"
                style={{
                  ...dropdownStyle,
                  background: "var(--popover)",
                  boxShadow: "0 25px 50px -12px rgb(0 0 0 / 0.5)",
                }}
                className="overflow-y-auto rounded-lg border border-border"
              >
                {suggestions.map((loc, i) => (
                  <li
                    key={loc}
                    role="option"
                    aria-selected={i === highlight}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      selectSuggestion(loc);
                    }}
                    onMouseEnter={() => setHighlight(i)}
                    style={
                      i === highlight
                        ? {
                            background: "var(--muted)",
                            color: "var(--foreground)",
                          }
                        : { color: "var(--muted-foreground)" }
                    }
                    className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm"
                  >
                    <MapPin className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">{loc}</span>
                  </li>
                ))}
              </ul>,
              document.body,
            )}
        </form>

        {error && (
          <div
            className="rounded-lg border px-3 py-2 text-sm"
            style={{
              color: "var(--destructive)",
              backgroundColor:
                "color-mix(in oklch, var(--destructive) 10%, transparent)",
              borderColor:
                "color-mix(in oklch, var(--destructive) 30%, transparent)",
            }}
          >
            {error}
          </div>
        )}

        {result && TIME_RESULT.test(result.text) ? (
          <div className="flex flex-col gap-3 rounded-2xl border border-border bg-surface-raised p-4">
            <div className="flex items-center gap-2 text-xs uppercase tracking-widest text-muted-fg">
              <MapPin className="h-3.5 w-3.5" />
              <span className="truncate">{locationLabel}</span>
            </div>
            <div
              className="font-mono tabular-nums"
              style={{ fontSize: "2.25rem", fontWeight: 300, letterSpacing: "-0.025em" }}
            >
              {display.timeLabel}
            </div>
            <div className="flex items-center gap-2 text-sm text-muted-fg">
              <span>{display.dateLabel}</span>
              {tzAbbr && (
                <>
                  <span className="text-muted-fg" aria-hidden="true">·</span>
                  <span
                    className="rounded-sm border border-border bg-surface-deep font-mono text-xs uppercase tracking-widest"
                    style={{ padding: "0.125rem 0.375rem" }}
                  >
                    {tzAbbr}
                  </span>
                </>
              )}
            </div>
          </div>
        ) : result ? (
          <div
            className="whitespace-pre-wrap rounded-2xl border border-border bg-surface-raised/60 px-4 py-3 text-sm text-muted-fg"
            style={{ overflowWrap: "break-word" }}
          >
            {result.text}
          </div>
        ) : null}
      </div>
    </div>
  );
}
