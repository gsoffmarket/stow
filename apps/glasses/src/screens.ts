// What the glasses show, derived purely from the last server snapshot and the
// local connection state. Rendering and input live in main.ts; keeping this
// pure means every screen can be tested without the SDK.
//
// The display has one fixed font and no alignment or bold, so hierarchy comes
// from position and capitals: a header row, a body, and one footer action.
// A tap does the footer action. On screens with more choices (report a
// problem, pause), a swipe opens a More screen drawn in the same text
// containers: swipe moves the cursor, tap chooses. The SDK's native menu was
// not used because the simulator could not select its items.

type PlanKind =
  | "OFFER"
  | "REVIEW_COMPLETE"
  | "REVIEW_CANCEL"
  | "REVIEW_RELEASE"
  | "QUEUE_EMPTY"
  | "CONFLICT"
  | "PAUSED";

/** Snapshot is the worker snapshot the API returns (see apps/api/src/http.ts). */
export type Snapshot = {
  readonly workspaceId: string;
  readonly cursor: string;
  readonly order: {
    readonly id: string;
    readonly ref: string;
    readonly revision: number;
    readonly version: string;
    readonly isCancelRequested: boolean;
    readonly toteId: string | null;
  } | null;
  readonly plan:
    | {
        readonly kind: "TASK";
        readonly taskToken: string;
        readonly task: {
          readonly kind: "PICK" | "RETURN";
          readonly lineId: string;
          readonly quantity: number;
          readonly revision: number;
          readonly version: string;
          readonly orderRef: string;
          readonly sku: string;
          readonly name: string;
          readonly bin: string | null;
          readonly toteId: string | null;
        };
        readonly progress: { readonly confirmed: number; readonly requested: number };
      }
    | { readonly kind: PlanKind }
    | { readonly kind: "REVISION_ACK"; readonly fromRevision: number; readonly toRevision: number }
    | { readonly kind: "RESOLUTION_ACK" | "BLOCKED"; readonly exceptionId: string }
    | { readonly kind: "TERMINAL"; readonly terminal: "COMPLETED" | "CANCELLED" };
  readonly changes: readonly { readonly sku: string; readonly from: number; readonly to: number; readonly picked: number }[];
  readonly decision: { readonly resolution: string; readonly sku: string; readonly target: number } | null;
  readonly lastCompleted: {
    readonly ref: string;
    readonly terminal: "COMPLETED" | "CANCELLED";
    readonly units: number;
    readonly delivery: "SENT" | "PENDING" | "UNCERTAIN" | "FAILED" | "NOT_REQUIRED";
  } | null;
};

/**
 * Link is the state of the last exchange with the server. "uncertain" means a
 * command was sent and no answer came back, so the outcome is unknown.
 */
export type Link = "online" | "saving" | "rejected" | "uncertain" | "offline";

export type ReportType = "SHORTAGE" | "DAMAGED" | "LOCATION_MISMATCH" | "RETURN_BLOCKED";

/** Action is what a tap does on the current screen. */
export type Action =
  | { readonly type: "CLAIM" | "COMPLETE" | "REFRESH" | "ACK_REVISION" | "PAUSE" | "RESUME" | "CLOSE_CANCELLED" | "DISMISS" | "BACK" }
  | { readonly type: "CONFIRM"; readonly quantity: number }
  | { readonly type: "ACK_RESOLUTION"; readonly exceptionId: string }
  | { readonly type: "REPORT"; readonly report: ReportType };

/** Option is one line on the More screen. */
export type Option = { readonly label: string; readonly action: Action };

export type Screen = {
  readonly header: string;
  readonly body: string;
  readonly footer: string;
  readonly primary: Action | null;
  /** What a swipe offers here; empty means swiping does nothing. */
  readonly options: readonly Option[];
};

const refresh: Action = { type: "REFRESH" };

function screen(header: string, body: string, footer: string, primary: Action | null, options: readonly Option[] = []): Screen {
  return { header, body, footer, primary, options };
}

const pickOptions: readonly Option[] = [
  { label: "REPORT SHORTAGE", action: { type: "REPORT", report: "SHORTAGE" } },
  { label: "DAMAGED ITEM", action: { type: "REPORT", report: "DAMAGED" } },
  { label: "WRONG LOCATION", action: { type: "REPORT", report: "LOCATION_MISMATCH" } },
  { label: "PAUSE ORDER", action: { type: "PAUSE" } },
];

const returnOptions: readonly Option[] = [
  { label: "CANNOT RETURN", action: { type: "REPORT", report: "RETURN_BLOCKED" } },
  { label: "PAUSE ORDER", action: { type: "PAUSE" } },
];

/**
 * moreScreen lists a screen's options with a cursor. The last line is always
 * Back, so a worker who swiped by accident can get out with one tap.
 */
export function moreScreen(base: Screen, ref: string, cursor: number): Screen {
  const options = [...base.options, { label: "BACK", action: { type: "BACK" } as Action }];
  const at = ((cursor % options.length) + options.length) % options.length;
  const body = options.map((option, index) => `${index === at ? ">" : " "} ${option.label}`).join("\n");
  return screen(`${ref}   MORE`, body, "SWIPE TO MOVE · TAP TO CHOOSE", options[at]!.action);
}

/**
 * screenFor picks the one screen to show. Connection problems outrank work,
 * and a just-closed order is confirmed before the next one is offered.
 * dismissedRef is the closed order the worker has already tapped past.
 */
export function screenFor(snapshot: Snapshot | null, link: Link, dismissedRef: string | null = null): Screen {
  const ref = snapshot?.order?.ref ?? "STOW";
  if (link === "offline") return screen(`${ref}   OFFLINE`, "NOT CONNECTED\nStop picking until synced.", "TAP TO RETRY", refresh);
  if (link === "saving") return screen(`${ref}   SAVING`, "SAVING…\nKeep the item in the tote.", "", null);
  if (link === "uncertain") return screen(`${ref}   CHECKING`, "OUTCOME UNKNOWN\nRecheck the tote before\nanything else.", "TAP TO CHECK", refresh);
  if (link === "rejected") return screen(`${ref}   NOT SAVED`, "NOT SAVED — ORDER CHANGED\nRecheck the tote.", "TAP FOR LATEST", refresh);
  if (!snapshot) return screen("STOW", "CONNECTING…", "", null);

  const plan = snapshot.plan;
  const done = snapshot.lastCompleted;
  if (done && done.ref !== dismissedRef && (plan.kind === "QUEUE_EMPTY" || plan.kind === "OFFER")) {
    const telegram = { SENT: "SENT", PENDING: "PENDING", UNCERTAIN: "NOT CONFIRMED", FAILED: "NOT SENT", NOT_REQUIRED: "NOT USED" }[done.delivery];
    const what = done.terminal === "COMPLETED" ? `${done.units} units confirmed` : "Cancelled, tote empty";
    return screen(`${done.ref}   ${done.terminal}`, `SAVED\n${what}\nTELEGRAM: ${telegram}`, "TAP FOR NEXT", { type: "DISMISS" });
  }

  switch (plan.kind) {
    case "TASK": {
      const { task, progress } = plan;
      const tote = task.toteId ? `TOTE ${task.toteId}` : "";
      const where = task.bin ? `BIN ${task.bin}` : "LOCATION NOT SET";
      if (task.kind === "RETURN") {
        const why = snapshot.order?.isCancelRequested ? "CANCELLED — RETURN REQUIRED\n" : "";
        return screen(
          `${task.orderRef}   ${tote}   RETURN`,
          `${why}RETURN × ${task.quantity}\n${task.name.toUpperCase()}\n${where} · ${task.sku}`,
          "TAP TO CONFIRM ACTUAL RETURN",
          { type: "CONFIRM", quantity: task.quantity },
          returnOptions,
        );
      }
      return screen(
        `${task.orderRef}   ${tote}   ${progress.confirmed}/${progress.requested}`,
        `${where}\n${task.name.toUpperCase()}\n${task.sku}\n\nPICK × ${task.quantity}`,
        "TAP TO CONFIRM · SWIPE FOR MORE",
        { type: "CONFIRM", quantity: task.quantity },
        pickOptions,
      );
    }
    case "REVISION_ACK": {
      const lines = snapshot.changes.map((change) => {
        const back = change.picked - change.to;
        return `${change.sku}  ${change.from} → ${change.to}${back > 0 ? ` · RETURN ${back}` : ""}`;
      });
      const title = snapshot.order?.isCancelRequested ? "STOP — ORDER CANCELLED" : "STOP — ORDER CHANGED";
      return screen(`${ref}   REVISION ${plan.toRevision}`, [title, ...lines.slice(0, 5)].join("\n"), "TAP TO ACKNOWLEDGE", { type: "ACK_REVISION" });
    }
    case "RESOLUTION_ACK": {
      const decision = snapshot.decision;
      const said =
        decision?.resolution === "REDUCE" ? `REDUCED: ${decision.sku} → ${decision.target}`
        : decision?.resolution === "SUBSTITUTE" ? `SUBSTITUTE FOR ${decision.sku}\n${snapshot.changes.filter((c) => c.from === 0).map((c) => `${c.sku} × ${c.to}`).join("\n")}`
        : decision?.resolution === "CANCEL" ? "ORDER CANCELLED\nReturn everything in the tote."
        : "CARRY ON AS ORDERED";
      return screen(`${ref}   COORDINATOR`, said, "TAP TO ACKNOWLEDGE", { type: "ACK_RESOLUTION", exceptionId: plan.exceptionId });
    }
    case "BLOCKED":
      return screen(`${ref}   WAITING`, "PROBLEM REPORTED\nWaiting for the coordinator.\nKeep the tote as it is.", "TAP TO REFRESH", refresh);
    case "PAUSED":
      return screen(`${ref}   PAUSED`, "PAUSED\nYour tote stays assigned to you.", "TAP TO RESUME", { type: "RESUME" });
    case "OFFER":
      return screen(`${ref}   NEW ORDER`, `${ref}\nReady to pick.`, "TAP TO START", { type: "CLAIM" });
    case "REVIEW_COMPLETE":
      return screen(`${ref}   REVIEW`, "ALL ITEMS IN THE TOTE\nCheck the tote, then complete.", "TAP TO COMPLETE", { type: "COMPLETE" }, [{ label: "PAUSE ORDER", action: { type: "PAUSE" } }]);
    case "REVIEW_CANCEL":
      return screen(`${ref}   CANCELLED`, "ALL ITEMS RETURNED\nClose the cancelled order.", "TAP TO CLOSE", { type: "CLOSE_CANCELLED" });
    case "TERMINAL":
      return screen(`${ref}   ${plan.terminal}`, plan.terminal === "COMPLETED" ? "SAVED\nOrder complete." : "Order cancelled.", "TAP FOR NEXT", refresh);
    case "QUEUE_EMPTY":
      return screen("STOW   READY", "NO ORDERS YET\nNew orders from the group\nappear here.", "TAP TO REFRESH", refresh);
    case "CONFLICT":
      return screen(`${ref}   STOP`, "THIS ORDER IS ASSIGNED\nTO SOMEONE ELSE", "TAP TO REFRESH", refresh);
    case "REVIEW_RELEASE":
      return screen(`${ref}   RELEASE`, "Waiting for the coordinator.", "TAP TO REFRESH", refresh);
  }
}

/**
 * pairingScreen is shown until the glasses hold a device token: a code to
 * approve from Stow in Telegram. Tap gets a fresh code.
 */
export function pairingScreen(code: string | null, link: Link): Screen {
  if (link === "offline") return screen("STOW   PAIR", "NOT CONNECTED\nCannot reach Stow.", "TAP TO RETRY", refresh);
  if (!code) return screen("STOW   PAIR", "GETTING A CODE…", "", null);
  return screen("STOW   PAIR", `CODE  ${code}\n\nOpen Stow in Telegram\nand enter this code.`, "TAP FOR A NEW CODE", refresh);
}
