/** Frontend half of the time plugin.

Exposes a default :class:`FrontendPlugin` so the registry in
``frontend/src/plugins/registry.ts`` picks it up at build time. The
``params`` and ``instanceTitle`` callbacks are moved verbatim from the
old hardcoded ``App.tsx`` entry so the panel's behavior (scan overlay
on LLM-driven opens, ``"Time in <city>"`` per-instance titles) is
unchanged.
*/

import { Clock } from "lucide-react";
import type { FrontendPlugin } from "@/plugins/types";
import { TimePanel } from "./TimePanel";

export default {
  id: "time",
  toolName: "get_local_time",
  panelComponentId: "timePanel",
  component: TimePanel,
  toolToPanel: {
    id: "time",
    component: "timePanel",
    title: "Time",
    floating: { width: 360, height: 360 },
    params: (args, result, extra) => ({
      location: typeof args.location === "string" ? args.location : "",
      text: result,
      // The time tool returns the resolved IANA timezone in ``extra.tz``
      // so the panel can keep the seconds ticking locally in the
      // requested zone instead of re-fetching every second. Fall back
      // to ``null`` (host clock) if the tool didn't provide one.
      tz: (extra.tz as string | null | undefined) ?? null,
      // ``scan: true`` is the signal the panel uses to show its
      // scan-line overlay. The chat populates ``result`` with the
      // tool's output, so the overlay only fires for LLM-driven
      // opens — not for the taskbar's empty-state open.
      scan: typeof result === "string" && result.length > 0,
    }),
    // Per-instance title so multiple time panels can be told apart
    // in the dockview tab strip.
    instanceTitle: (args) => {
      const loc = typeof args.location === "string" ? args.location.trim() : "";
      return loc ? `Time in ${loc}` : "Time";
    },
  },
  taskbar: {
    id: "time",
    label: "Time",
    // ``icon`` is the string name mirrored in the backend manifest
    // for the ``/config`` payload; ``Icon`` is the Lucide component
    // the taskbar actually renders. Self-hosting ``Icon`` keeps the
    // plugin self-contained — no core edit needed to register a new
    // icon name.
    icon: "clock",
    Icon: Clock,
    toolName: "get_local_time",
  },
} satisfies FrontendPlugin;
