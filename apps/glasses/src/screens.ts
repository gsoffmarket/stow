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
    readonly isReleaseRequested: boolean;
    readonly toteId: string | null;
    readonly lines: readonly { readonly requested: number }[];
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
  /** Every order the worker carries, when picking a batch. */
  readonly totes: readonly { readonly orderId: string; readonly ref: string; readonly toteId: string | null; readonly picked: number; readonly requested: number }[];
  /** Queued orders that can be started together, when at least two are waiting. */
  readonly batchOffer: readonly { readonly orderId: string; readonly ref: string; readonly revision: number; readonly version: string }[];
  readonly changes: readonly { readonly sku: string; readonly from: number; readonly to: number; readonly picked: number }[];
  readonly decision: { readonly resolution: string; readonly sku: string; readonly target: number } | null;
  readonly lastCompleted: {
    readonly ref: string;
    readonly terminal: "COMPLETED" | "CANCELLED";
    readonly units: number;
    readonly delivery: "SENT" | "PENDING" | "UNCERTAIN" | "FAILED" | "NOT_REQUIRED";
  } | null;
  readonly note: { readonly id: string; readonly body: string; readonly author: string } | null;
  readonly quickReplies: readonly { readonly id: string; readonly text: string }[];
};

/**
 * Link is the state of the last exchange with the server. "uncertain" means a
 * command was sent and no answer came back, so the outcome is unknown.
 */
export type Link = "online" | "saving" | "rejected" | "uncertain" | "offline";

export type ReportType = "SHORTAGE" | "DAMAGED" | "LOCATION_MISMATCH" | "RETURN_BLOCKED";

/** Action is what a tap does on the current screen. */
export type Action =
  | { readonly type: "CLAIM" | "COMPLETE" | "REFRESH" | "ACK_REVISION" | "PAUSE" | "RESUME" | "CLOSE_CANCELLED" | "PREPARE_RELEASE" | "CANCEL_RELEASE" | "RELEASE" | "TOGGLE_AUTO_NEXT" | "DISMISS" | "BACK" | "REPLIES" | "CHOOSE_QUANTITY" }
  | { readonly type: "MARK_READ"; readonly noteId: string }
  | { readonly type: "REPLY"; readonly replyId: string; readonly noteId: string | null }
  | { readonly type: "CONFIRM"; readonly quantity: number }
  | { readonly type: "REVIEW_BATCH" | "START_BATCH"; readonly size: number }
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

const messageGroup: Option = { label: "MESSAGE GROUP", action: { type: "REPLIES" } };

const pickOptions: readonly Option[] = [
  { label: "PICK FEWER", action: { type: "CHOOSE_QUANTITY" } },
  { label: "REPORT SHORTAGE", action: { type: "REPORT", report: "SHORTAGE" } },
  { label: "DAMAGED ITEM", action: { type: "REPORT", report: "DAMAGED" } },
  { label: "WRONG LOCATION", action: { type: "REPORT", report: "LOCATION_MISMATCH" } },
  messageGroup,
  { label: "PAUSE ORDER", action: { type: "PAUSE" } },
  { label: "RELEASE ORDER", action: { type: "PREPARE_RELEASE" } },
];

const keepOrder: Option = { label: "KEEP ORDER", action: { type: "CANCEL_RELEASE" } };

const returnOptions: readonly Option[] = [
  { label: "RETURN FEWER", action: { type: "CHOOSE_QUANTITY" } },
  { label: "CANNOT RETURN", action: { type: "REPORT", report: "RETURN_BLOCKED" } },
  messageGroup,
  { label: "PAUSE ORDER", action: { type: "PAUSE" } },
];

/**
 * replyOptions turns the server's quick replies into More-screen lines. A
 * reply sent from a note also marks that note read.
 */
export function replyOptions(snapshot: Snapshot, noteId: string | null): Option[] {
  return snapshot.quickReplies.map((reply) => ({ label: reply.text.toUpperCase(), action: { type: "REPLY", replyId: reply.id, noteId } }));
}

// The body container shows about seven lines of the display font; a longer
// list scrolls with the cursor so the choice under it is always visible.
const moreLines_max = 6;

/**
 * moreScreen lists a screen's options with a cursor. The last line is always
 * Back, so a worker who swiped by accident can get out with one tap.
 */
export function moreScreen(choices: readonly Option[], ref: string, cursor: number): Screen {
  const options = [...choices, { label: "BACK", action: { type: "BACK" } as Action }];
  const at = ((cursor % options.length) + options.length) % options.length;
  const first = Math.max(0, Math.min(at - moreLines_max + 1, options.length - moreLines_max));
  const body = options
    .map((option, index) => `${index === at ? ">" : " "} ${option.label}`)
    .slice(first, first + moreLines_max)
    .join("\n");
  return screen(`${ref}   MORE`, body, "SWIPE TO MOVE · TAP TO CHOOSE", options[at]!.action);
}

/**
 * Local is what the glasses keep for themselves: the closed order whose Saved
 * screen the worker already tapped past, and whether they turned on
 * auto-next (PRD §7.7, off by default).
 */
export type Local = { readonly dismissedRef: string | null; readonly isAutoNext: boolean };

const noLocal: Local = { dismissedRef: null, isAutoNext: false };

function sizeOf(snapshot: Snapshot): string {
  const lines = snapshot.order?.lines ?? [];
  const units = lines.reduce((sum, line) => sum + line.requested, 0);
  return `${lines.length} ${lines.length === 1 ? "LINE" : "LINES"} · ${units} ${units === 1 ? "UNIT" : "UNITS"}`;
}

/**
 * screenFor picks the one screen to show. Connection problems outrank work,
 * and a just-closed order is confirmed before the next one is offered. With
 * auto-next on, the confirmation and the next offer share one screen, but
 * starting the next order is still the picker's tap.
 */
export function screenFor(snapshot: Snapshot | null, link: Link, local: Local = noLocal): Screen {
  const ref = snapshot?.order?.ref ?? "STOW";
  if (link === "offline") return screen(`${ref}   OFFLINE`, "NOT CONNECTED\nStop picking until synced.", "TAP TO RETRY", refresh);
  if (link === "saving") return screen(`${ref}   SAVING`, "SAVING…\nKeep the item in the tote.", "", null);
  if (link === "uncertain") return screen(`${ref}   CHECKING`, "OUTCOME UNKNOWN\nRecheck the tote before\nanything else.", "TAP TO CHECK", refresh);
  if (link === "rejected") return screen(`${ref}   NOT SAVED`, "NOT SAVED — ORDER CHANGED\nRecheck the tote.", "TAP FOR LATEST", refresh);
  if (!snapshot) return screen("STOW", "CONNECTING…", "", null);

  const plan = snapshot.plan;
  // A coordinator note waits for a safe moment: never over saving or an
  // unknown outcome (handled above), and only on the worker's own order.
  if (snapshot.note && snapshot.order) {
    const note = snapshot.note;
    return screen(`${ref}   NOTE · ${note.author.toUpperCase()}`, note.body, "TAP: GOT IT · SWIPE: REPLY", { type: "MARK_READ", noteId: note.id }, replyOptions(snapshot, note.id));
  }
  const done = snapshot.lastCompleted;
  if (done && done.ref !== local.dismissedRef && (plan.kind === "QUEUE_EMPTY" || plan.kind === "OFFER")) {
    const telegram = { SENT: "SENT", PENDING: "PENDING", UNCERTAIN: "NOT CONFIRMED", FAILED: "NOT SENT", NOT_REQUIRED: "NOT USED" }[done.delivery];
    const what = done.terminal === "COMPLETED" ? `${done.units} ${done.units === 1 ? "unit" : "units"} confirmed` : "Cancelled, tote empty";
    if (local.isAutoNext && plan.kind === "OFFER") {
      return screen(`${done.ref}   ${done.terminal}`, `SAVED · ${what}\nTELEGRAM: ${telegram}\n\nNEXT  ${ref}\n${sizeOf(snapshot)}`, "TAP TO START NEXT", { type: "CLAIM" });
    }
    return screen(`${done.ref}   ${done.terminal}`, `SAVED\n${what}\nTELEGRAM: ${telegram}`, "TAP FOR NEXT", { type: "DISMISS" });
  }

  switch (plan.kind) {
    case "TASK": {
      const { task, progress } = plan;
      const tote = task.toteId ? `TOTE ${task.toteId}` : "";
      const where = task.bin ? `BIN ${task.bin}` : "LOCATION NOT SET";
      // With several totes on the cart, which one is as important as how many.
      const into = snapshot.totes.length > 1 && task.toteId ? ` → TOTE ${task.toteId}` : "";
      const from = snapshot.totes.length > 1 && task.toteId ? ` FROM TOTE ${task.toteId}` : "";
      if (task.kind === "RETURN") {
        const isReleasing = snapshot.order?.isReleaseRequested === true;
        const why = snapshot.order?.isCancelRequested ? "CANCELLED — RETURN REQUIRED\n" : isReleasing ? "RELEASING — EMPTY THE TOTE\n" : "";
        const options = task.quantity > 1 ? returnOptions : returnOptions.slice(1);
        return screen(
          `${task.orderRef}   ${tote}   RETURN`,
          `${why}RETURN × ${task.quantity}${from}\n${task.name.toUpperCase()}\n${where} · ${task.sku}`,
          "TAP TO CONFIRM ACTUAL RETURN",
          { type: "CONFIRM", quantity: task.quantity },
          isReleasing ? [...options, keepOrder] : options,
        );
      }
      return screen(
        `${task.orderRef}   ${tote}   ${progress.confirmed}/${progress.requested}`,
        `${where}\n${task.name.toUpperCase()}\n${task.sku}\n\nPICK × ${task.quantity}${into}`,
        "TAP TO CONFIRM · SWIPE FOR MORE",
        { type: "CONFIRM", quantity: task.quantity },
        task.quantity > 1 ? pickOptions : pickOptions.slice(1),
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
    case "OFFER": {
      const batches = snapshot.batchOffer.slice(1).map((_, index) => ({ label: `BATCH OF ${index + 2}`, action: { type: "REVIEW_BATCH", size: index + 2 } as Action }));
      const footer = batches.length > 0 ? "TAP TO START · SWIPE FOR BATCH" : "TAP TO START · SWIPE FOR SETTINGS";
      return screen(`${ref}   NEW ORDER`, `${ref}\n${sizeOf(snapshot)}\nReady to pick.`, footer, { type: "CLAIM" }, [...batches, autoNextOption(local)]);
    }
    case "REVIEW_COMPLETE": {
      const tote = snapshot.totes.length > 1 && snapshot.order?.toteId ? `TOTE ${snapshot.order.toteId}` : "THE TOTE";
      return screen(`${ref}   REVIEW`, `ALL ITEMS IN ${tote}\nCheck the tote, then complete.`, "TAP TO COMPLETE", { type: "COMPLETE" }, [{ label: "PAUSE ORDER", action: { type: "PAUSE" } }]);
    }
    case "REVIEW_CANCEL":
      return screen(`${ref}   CANCELLED`, "ALL ITEMS RETURNED\nClose the cancelled order.", "TAP TO CLOSE", { type: "CLOSE_CANCELLED" });
    case "TERMINAL":
      return screen(`${ref}   ${plan.terminal}`, plan.terminal === "COMPLETED" ? "SAVED\nOrder complete." : "Order cancelled.", "TAP FOR NEXT", refresh);
    case "QUEUE_EMPTY":
      return screen("STOW   READY", "NO ORDERS YET\nNew orders from the group\nappear here.", "TAP TO REFRESH · SWIPE FOR SETTINGS", refresh, [autoNextOption(local)]);
    case "CONFLICT":
      return screen(`${ref}   STOP`, "THIS ORDER IS ASSIGNED\nTO SOMEONE ELSE", "TAP TO REFRESH", refresh);
    case "REVIEW_RELEASE":
      return screen(`${ref}   RELEASE`, "TOTE EMPTY\nHand the order back to the queue.", "TAP TO RELEASE · SWIPE TO KEEP", { type: "RELEASE" }, [keepOrder]);
  }
}

function autoNextOption(local: Local): Option {
  return { label: `AUTO-NEXT: ${local.isAutoNext ? "ON" : "OFF"}`, action: { type: "TOGGLE_AUTO_NEXT" } };
}

const toteLabels = ["A", "B", "C", "D", "E"] as const;

/**
 * batchScreen shows which order goes in which tote before a batch starts, so
 * the picker labels the totes first (PRD §7.6). A swipe goes back to the offer.
 */
export function batchScreen(snapshot: Snapshot, size: number): Screen {
  const mapping = snapshot.batchOffer.slice(0, size).map((order, index) => `TOTE ${toteLabels[index]}  ${order.ref}`);
  return screen(`BATCH OF ${size}   TOTES`, [...mapping, "Label each tote, then start."].join("\n"), "TAP TO START · SWIPE TO GO BACK", { type: "START_BATCH", size });
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

/**
 * quantityScreen confirms fewer units than the task asks for, when that is
 * all the picker actually moved. Swipes change the number; 0 means cancel,
 * because confirming nothing is never a real confirmation. The rest stays
 * outstanding as a new task.
 */
export function quantityScreen(snapshot: Snapshot, chosen: number): Screen | null {
  const plan = snapshot.plan;
  if (plan.kind !== "TASK") return null;
  const { task } = plan;
  const verb = task.kind === "PICK" ? "PICK" : "RETURN";
  const header = `${task.orderRef}   ${task.toteId ? `TOTE ${task.toteId}` : ""}   HOW MANY?`;
  if (chosen <= 0) return screen(header, `CANCEL\n${verb} × ${task.quantity} stays as asked.`, "SWIPE TO CHANGE · TAP TO GO BACK", { type: "BACK" });
  return screen(
    header,
    `${verb} × ${chosen}\nof ${task.quantity} asked\n${task.name.toUpperCase()}\n${task.sku}`,
    "SWIPE TO CHANGE · TAP TO CONFIRM",
    { type: "CONFIRM", quantity: chosen },
  );
}

/** clampQuantity keeps a chosen quantity between cancel (0) and what the task asks. */
export function clampQuantity(chosen: number, asked: number): number {
  return Math.min(Math.max(chosen, 0), asked);
}
