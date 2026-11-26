// What the glasses show, derived purely from the last server snapshot and the
// local connection state. Rendering and input live in main.ts; keeping this
// pure means every screen can be tested without the SDK.
//
// The display has one fixed font and no alignment or bold, so hierarchy comes
// from position and capitals: a header row, a body, and one footer action.

/** Snapshot is the worker snapshot the API returns (see apps/api/src/http.ts). */
export type Snapshot = {
  readonly workspaceId: string;
  readonly cursor: string;
  readonly order: {
    readonly id: string;
    readonly ref: string;
    readonly revision: number;
    readonly version: string;
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
    | { readonly kind: "OFFER" | "REVIEW_COMPLETE" | "QUEUE_EMPTY" | "CONFLICT" | "PAUSED" | "BLOCKED" | "REVISION_ACK" | "RESOLUTION_ACK" | "REVIEW_CANCEL" | "REVIEW_RELEASE" }
    | { readonly kind: "TERMINAL"; readonly terminal: "COMPLETED" | "CANCELLED" };
};

/**
 * Link is the state of the last exchange with the server. "uncertain" means a
 * command was sent and no answer came back, so the outcome is unknown.
 */
export type Link = "online" | "saving" | "rejected" | "uncertain" | "offline";

/** Action is what a primary tap does on the current screen. */
export type Action =
  | { readonly type: "CLAIM" }
  | { readonly type: "CONFIRM"; readonly quantity: number }
  | { readonly type: "COMPLETE" }
  | { readonly type: "REFRESH" };

export type Screen = { readonly header: string; readonly body: string; readonly footer: string; readonly primary: Action | null };

/** screenFor picks the one screen to show; connection problems outrank work. */
export function screenFor(snapshot: Snapshot | null, link: Link): Screen {
  const ref = snapshot?.order?.ref ?? "STOW";
  if (link === "offline") {
    return { header: `${ref}   OFFLINE`, body: "NOT CONNECTED\nStop picking until synced.", footer: "TAP TO RETRY", primary: { type: "REFRESH" } };
  }
  if (link === "saving") return { header: `${ref}   SAVING`, body: "SAVING…\nKeep the item in the tote.", footer: "", primary: null };
  if (link === "uncertain") {
    return { header: `${ref}   CHECKING`, body: "OUTCOME UNKNOWN\nRecheck the tote before\nanything else.", footer: "TAP TO CHECK", primary: { type: "REFRESH" } };
  }
  if (link === "rejected") {
    return { header: `${ref}   NOT SAVED`, body: "NOT SAVED — ORDER CHANGED\nRecheck the tote.", footer: "TAP FOR LATEST", primary: { type: "REFRESH" } };
  }
  if (!snapshot) return { header: "STOW", body: "CONNECTING…", footer: "", primary: null };

  const plan = snapshot.plan;
  switch (plan.kind) {
    case "TASK": {
      const { task, progress } = plan;
      const tote = task.toteId ? `TOTE ${task.toteId}` : "";
      const verb = task.kind === "PICK" ? "PICK" : "RETURN";
      const where = task.bin ? `BIN ${task.bin}` : "LOCATION NOT SET";
      return {
        header: `${task.orderRef}   ${tote}   ${progress.confirmed}/${progress.requested}`,
        body: `${where}\n${task.name.toUpperCase()}\n${task.sku}\n\n${verb} × ${task.quantity}`,
        footer: task.kind === "PICK" ? "TAP TO CONFIRM" : "TAP TO CONFIRM ACTUAL RETURN",
        primary: { type: "CONFIRM", quantity: task.quantity },
      };
    }
    case "OFFER":
      return { header: `${ref}   NEW ORDER`, body: `${ref}\nReady to pick.`, footer: "TAP TO START", primary: { type: "CLAIM" } };
    case "REVIEW_COMPLETE":
      return { header: `${ref}   REVIEW`, body: "ALL ITEMS IN THE TOTE\nCheck the tote, then complete.", footer: "TAP TO COMPLETE", primary: { type: "COMPLETE" } };
    case "TERMINAL":
      return { header: `${ref}   ${plan.terminal}`, body: plan.terminal === "COMPLETED" ? "SAVED\nOrder complete." : "Order cancelled.", footer: "TAP FOR NEXT", primary: { type: "REFRESH" } };
    case "QUEUE_EMPTY":
      return { header: "STOW   READY", body: "NO ORDERS YET\nNew orders from the group\nappear here.", footer: "TAP TO REFRESH", primary: { type: "REFRESH" } };
    case "CONFLICT":
      return { header: `${ref}   STOP`, body: "THIS ORDER IS ASSIGNED\nTO SOMEONE ELSE", footer: "TAP TO REFRESH", primary: { type: "REFRESH" } };
    default:
      // Revisions, exceptions, pause, cancel and release screens arrive with
      // the features that create those states.
      return { header: `${ref}   ${plan.kind.replace(/_/g, " ")}`, body: "Waiting for the coordinator.", footer: "TAP TO REFRESH", primary: { type: "REFRESH" } };
  }
}
