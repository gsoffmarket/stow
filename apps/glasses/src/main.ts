/// <reference types="vite/client" />
// The glasses app: poll the worker snapshot, draw the screen, turn a tap into
// a command. All decisions live on the server and in screens.ts; this file is
// the thin layer that talks to the Even Hub bridge and the API.
//
// Bridge rules from the Even Hub docs that shape this file: create the page
// exactly once, then only update text in place; serialise every bridge call;
// cap each call with a timeout because a Bluetooth hop can hang.

import {
  CreateStartUpPageContainer,
  OsEventTypeList,
  TextContainerProperty,
  TextContainerUpgrade,
  waitForEvenAppBridge,
  type EvenAppBridge,
} from "@evenrealities/even_hub_sdk";
import {
  clampQuantity,
  moreScreen,
  pairingScreen,
  quantityScreen,
  replyOptions,
  screenFor,
  type Action,
  type Link,
  type Option,
  type Screen,
  type Snapshot,
} from "./screens.ts";

const apiUrl = import.meta.env.VITE_STOW_API_URL as string;

/** Credentials are what pairing leaves on the glasses. */
type Credentials = { readonly token: string; readonly workspaceId: string };

// Local development may skip pairing with a token from pnpm setup:local.
// Production builds never read it.
const devCredentials: Credentials | null =
  import.meta.env.DEV && import.meta.env.VITE_STOW_DEV_DEVICE_TOKEN
    ? { token: import.meta.env.VITE_STOW_DEV_DEVICE_TOKEN as string, workspaceId: import.meta.env.VITE_STOW_WORKSPACE_ID as string }
    : null;
const storageKey = "stow.device";

const pollInterval_ms = 1_500;
const pairingPoll_ms = 2_000;
const bridgeTimeout_ms = 4_000;
const requestTimeout_ms = 8_000;
const tapDebounce_ms = 250;

const regions = [
  { id: 1, name: "header", y: 0, height: 44 },
  { id: 2, name: "body", y: 44, height: 196 },
  { id: 3, name: "footer", y: 240, height: 48 },
] as const;

// A write to the API. Commands carry their own command ID and replies a
// client ID, so resending the same Pending after a lost answer is safe.
type Pending = { readonly path: string; readonly body: object };
type Pairing = { readonly pairingId: string; readonly code: string; readonly secret: string };

let bridge: EvenAppBridge;
let credentials: Credentials | null = null;
let pairing: Pairing | null = null;
let snapshot: Snapshot | null = null;
let link: Link = "online";
let pending: Pending | null = null;
let shown: Screen | null = null;
let lastTap_ms = 0;
let isForeground = true;
// The closed order the worker has tapped past; its Saved screen stays until then.
let dismissedRef: string | null = null;
// Cursor on the More screen, or null when it is closed. It closes whenever
// the underlying screen changes, so it can never act on a stale task.
let moreCursor: number | null = null;
// What the More screen lists when it is not the screen's own options (the quick replies).
let moreList: readonly Option[] | null = null;
// The quantity being chosen on the "how many?" screen, or null when it is closed.
let chosenQuantity: number | null = null;
let base: Screen | null = null;
let bridgeQueue: Promise<unknown> = Promise.resolve();

// Every bridge call goes through here, one at a time, each with a deadline.
function onBridge<T>(call: () => Promise<T>): Promise<T> {
  const run = bridgeQueue.then(() =>
    Promise.race([
      call(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("bridge call timed out")), bridgeTimeout_ms)),
    ]),
  );
  bridgeQueue = run.catch(() => undefined);
  return run;
}

async function render(): Promise<void> {
  const underlying = credentials ? screenFor(snapshot, link, dismissedRef) : pairingScreen(pairing?.code ?? null, link);
  if (base && (underlying.header !== base.header || underlying.body !== base.body)) {
    moreCursor = null;
    moreList = null;
    chosenQuantity = null;
  }
  base = underlying;
  const choices = moreList ?? underlying.options;
  const choosing = chosenQuantity !== null && snapshot ? quantityScreen(snapshot, chosenQuantity) : null;
  const next = choosing ?? (moreCursor !== null && choices.length > 0 ? moreScreen(choices, snapshot?.order?.ref ?? "STOW", moreCursor) : underlying);
  const texts = { header: next.header, body: next.body, footer: next.footer };
  if (!shown) {
    const textObject = regions.map(
      (region) =>
        new TextContainerProperty({
          xPosition: 0,
          yPosition: region.y,
          width: 576,
          height: region.height,
          borderWidth: 0,
          paddingLength: region.name === "body" ? 8 : 4,
          containerID: region.id,
          containerName: region.name,
          content: texts[region.name],
          isEventCapture: region.name === "body" ? 1 : 0,
        }),
    );
    await onBridge(() => bridge.createStartUpPageContainer(new CreateStartUpPageContainer({ containerTotalNum: 3, textObject })));
  } else {
    for (const region of regions) {
      if (shown[region.name] === texts[region.name]) continue;
      await onBridge(() =>
        bridge.textContainerUpgrade(
          new TextContainerUpgrade({ containerID: region.id, containerName: region.name, contentOffset: 0, contentLength: 0, content: texts[region.name] }),
        ),
      );
    }
  }
  shown = next;
}

async function request(method: "GET" | "POST", path: string, body?: object): Promise<Response> {
  const { token, workspaceId } = credentials!;
  return fetch(`${apiUrl}/v1/workspaces/${workspaceId}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : null,
    signal: AbortSignal.timeout(requestTimeout_ms),
  });
}

async function loadCredentials(): Promise<Credentials | null> {
  if (devCredentials) return devCredentials;
  const saved = await onBridge(() => bridge.getLocalStorage(storageKey));
  try {
    const parsed = JSON.parse(saved) as Partial<Credentials>;
    return typeof parsed.token === "string" && typeof parsed.workspaceId === "string" ? { token: parsed.token, workspaceId: parsed.workspaceId } : null;
  } catch {
    return null;
  }
}

async function saveCredentials(next: Credentials | null): Promise<void> {
  credentials = next;
  await onBridge(() => bridge.setLocalStorage(storageKey, next ? JSON.stringify(next) : ""));
}

async function pairingRequest(method: "GET" | "POST", path: string, body?: object): Promise<Response> {
  return fetch(`${apiUrl}/v1/devices/pairings${path}`, {
    method,
    headers: { ...(pairing ? { "x-pairing-secret": pairing.secret } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : null,
    signal: AbortSignal.timeout(requestTimeout_ms),
  });
}

// One step of pairing: get a code if there is none, otherwise check whether
// it was approved and, if so, swap it for a device token.
async function pairStep(): Promise<void> {
  try {
    if (!pairing) {
      const started = await pairingRequest("POST", "", { label: "Even G2" });
      if (!started.ok) throw new Error(`pairing: HTTP ${started.status}`);
      pairing = ((await started.json()) as { data: Pairing }).data;
    } else {
      const pairingId = pairing.pairingId;
      const polled = await pairingRequest("GET", `/${pairingId}`);
      const status = polled.ok ? ((await polled.json()) as { data: { status: string } }).data.status : "EXPIRED";
      if (status === "EXPIRED" || status === "CONSUMED") pairing = null;
      if (status === "APPROVED") {
        const swapped = await pairingRequest("POST", `/${pairingId}/exchange`);
        if (!swapped.ok) throw new Error(`exchange: HTTP ${swapped.status}`);
        const issued = ((await swapped.json()) as { data: Credentials }).data;
        pairing = null;
        await saveCredentials({ token: issued.token, workspaceId: issued.workspaceId });
        return refresh();
      }
    }
    link = "online";
  } catch (error) {
    console.warn("pairing failed", error);
    link = "offline";
  }
  await render();
}

async function refresh(): Promise<void> {
  try {
    const response = await request("GET", "/worker/snapshot");
    // A revoked or expired device token sends the glasses back to pairing.
    if (response.status === 401) {
      snapshot = null;
      await saveCredentials(null);
      return pairStep();
    }
    if (!response.ok) throw new Error(`snapshot: HTTP ${response.status}`);
    snapshot = ((await response.json()) as { data: Snapshot }).data;
    if (link === "offline" || link === "rejected") link = "online";
  } catch (error) {
    console.warn("snapshot failed", error);
    if (link !== "uncertain") link = "offline";
  }
  await render();
}

// Sends a command and settles the link state. A lost response is "uncertain",
// not "failed": the server may have saved it, so the same command ID is sent
// again on the next tap and the server's idempotency answers truthfully.
async function send(command: Pending): Promise<void> {
  pending = command;
  link = "saving";
  await render();
  try {
    const response = await request("POST", command.path, command.body);
    pending = null;
    link = response.ok ? "online" : response.status === 409 ? "rejected" : "offline";
  } catch (error) {
    console.warn("command outcome unknown", error);
    link = "uncertain";
  }
  await refresh();
}

function commandFor(action: Action): object | null {
  if (!snapshot?.order) return null;
  const order = snapshot.order;
  const expected = { orderId: order.id, expectedRevision: order.revision, expectedVersion: order.version };
  const plan = snapshot.plan;
  switch (action.type) {
    case "CLAIM":
      return { type: "CLAIM_ORDER", ...expected, payload: { toteId: "A" } };
    case "COMPLETE":
      return { type: "COMPLETE_ORDER", ...expected, payload: {} };
    case "ACK_REVISION":
      return { type: "ACK_REVISION", ...expected, payload: {} };
    case "PAUSE":
      return { type: "PAUSE_ORDER", ...expected, payload: {} };
    case "RESUME":
      return { type: "RESUME_ORDER", ...expected, payload: {} };
    case "CLOSE_CANCELLED":
      return { type: "CLOSE_CANCELLED", ...expected, payload: {} };
    case "ACK_RESOLUTION":
      return { type: "ACK_RESOLUTION", ...expected, payload: { exceptionId: action.exceptionId } };
    case "REPORT":
      return { type: "REPORT_EXCEPTION", ...expected, payload: { type: action.report, reportedQty: null } };
    case "CONFIRM":
      if (plan.kind !== "TASK") return null;
      return {
        type: "CONFIRM_TASK",
        ...expected,
        payload: { taskToken: plan.taskToken, kind: plan.task.kind, lineId: plan.task.lineId, quantity: action.quantity },
      };
    case "START_BATCH":
    case "REFRESH":
    case "DISMISS":
    case "BACK":
    case "REPLIES":
    case "MARK_READ":
    case "REPLY":
    case "CHOOSE_QUANTITY":
      return null;
  }
}

async function perform(action: Action | null | undefined): Promise<void> {
  const now = performance.now();
  if (now - lastTap_ms < tapDebounce_ms || link === "saving") return;
  lastTap_ms = now;
  if (link === "uncertain" && pending) return send(pending);
  if (!action) return;
  if (action.type === "BACK") {
    moreCursor = null;
    moreList = null;
    chosenQuantity = null;
    return render();
  }
  if (action.type === "CHOOSE_QUANTITY") {
    const plan = snapshot?.plan;
    moreCursor = null;
    chosenQuantity = plan?.kind === "TASK" ? plan.task.quantity - 1 : null;
    return render();
  }
  if (action.type === "REPLIES") {
    moreList = snapshot ? replyOptions(snapshot, null) : null;
    moreCursor = 0;
    return render();
  }
  moreCursor = null;
  moreList = null;
  chosenQuantity = null;
  if (action.type === "DISMISS") {
    dismissedRef = snapshot?.lastCompleted?.ref ?? null;
    return render();
  }
  if (!credentials) {
    pairing = null;
    return pairStep();
  }
  if (action.type === "MARK_READ") return send({ path: `/messages/${action.noteId}/read`, body: {} });
  if (action.type === "REPLY") {
    if (!snapshot?.order) return;
    await send({ path: "/replies", body: { clientId: crypto.randomUUID(), orderId: snapshot.order.id, replyId: action.replyId } });
    if (action.noteId && link === "online") await send({ path: `/messages/${action.noteId}/read`, body: {} });
    return;
  }
  if (action.type === "START_BATCH") {
    const orders = (snapshot?.batchOffer ?? []).slice(0, action.size).map((order) => ({ orderId: order.orderId, expectedRevision: order.revision, expectedVersion: order.version }));
    return send({ path: "/batches", body: { commandId: crypto.randomUUID(), orders } });
  }
  const body = commandFor(action);
  if (!body) return refresh();
  return send({ path: "/commands", body: { commandId: crypto.randomUUID(), ...body } });
}

function listen(): void {
  bridge.onEvenHubEvent((event) => {
    // Swipes on a text container arrive as textEvent: 1 is up, 2 is down.
    const scroll = event.textEvent?.eventType;
    if (scroll === OsEventTypeList.SCROLL_TOP_EVENT || scroll === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
      const plan = snapshot?.plan;
      if (chosenQuantity !== null && plan?.kind === "TASK") {
        // Swipe up adds one, swipe down takes one away; zero is cancel.
        chosenQuantity = clampQuantity(chosenQuantity + (scroll === OsEventTypeList.SCROLL_TOP_EVENT ? 1 : -1), plan.task.quantity);
        void render();
        return;
      }
      if (!base || (moreList ?? base.options).length === 0 || link !== "online") return;
      const step = scroll === OsEventTypeList.SCROLL_BOTTOM_EVENT ? 1 : -1;
      moreCursor = moreCursor === null ? 0 : moreCursor + step;
      void render();
      return;
    }
    const system = event.sysEvent;
    if (!system) return;
    // Protobuf drops zero values, so a single tap arrives with no eventType.
    const type = system.eventType ?? OsEventTypeList.CLICK_EVENT;
    if (type === OsEventTypeList.CLICK_EVENT) void perform(shown?.primary);
    else if (type === OsEventTypeList.DOUBLE_CLICK_EVENT) void onBridge(() => bridge.shutDownPageContainer(1));
    else if (type === OsEventTypeList.FOREGROUND_ENTER_EVENT) {
      isForeground = true;
      void refresh();
    } else if (type === OsEventTypeList.FOREGROUND_EXIT_EVENT) isForeground = false;
  });
}

async function pollLoop(): Promise<void> {
  if (isForeground && link !== "saving" && link !== "uncertain") await (credentials ? refresh() : pairStep());
  setTimeout(() => void pollLoop(), credentials ? pollInterval_ms : pairingPoll_ms);
}

bridge = await waitForEvenAppBridge();
await render();
credentials = await loadCredentials();
listen();
await pollLoop();
