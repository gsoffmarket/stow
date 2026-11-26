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
import { screenFor, type Action, type Link, type Screen, type Snapshot } from "./screens.ts";

const apiUrl = import.meta.env.VITE_STOW_API_URL as string;
const workspaceId = import.meta.env.VITE_STOW_WORKSPACE_ID as string;
// Gate A only: a device token issued by the local setup script. Pairing from
// the companion replaces this before any hosted build.
const deviceToken = import.meta.env.DEV ? (import.meta.env.VITE_STOW_DEV_DEVICE_TOKEN as string) : "";

const pollInterval_ms = 1_500;
const bridgeTimeout_ms = 4_000;
const requestTimeout_ms = 8_000;
const tapDebounce_ms = 250;

const regions = [
  { id: 1, name: "header", y: 0, height: 44 },
  { id: 2, name: "body", y: 44, height: 196 },
  { id: 3, name: "footer", y: 240, height: 48 },
] as const;

type Pending = { readonly commandId: string; readonly body: object };

let bridge: EvenAppBridge;
let snapshot: Snapshot | null = null;
let link: Link = "online";
let pending: Pending | null = null;
let shown: Screen | null = null;
let lastTap_ms = 0;
let isForeground = true;
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
  const next = screenFor(snapshot, link);
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
  return fetch(`${apiUrl}/v1/workspaces/${workspaceId}${path}`, {
    method,
    headers: { authorization: `Bearer ${deviceToken}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : null,
    signal: AbortSignal.timeout(requestTimeout_ms),
  });
}

async function refresh(): Promise<void> {
  try {
    const response = await request("GET", "/worker/snapshot");
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
    const response = await request("POST", "/commands", { commandId: command.commandId, ...command.body });
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
    case "CONFIRM":
      if (plan.kind !== "TASK") return null;
      return {
        type: "CONFIRM_TASK",
        ...expected,
        payload: { taskToken: plan.taskToken, kind: plan.task.kind, lineId: plan.task.lineId, quantity: action.quantity },
      };
    case "REFRESH":
      return null;
  }
}

async function onPrimaryTap(): Promise<void> {
  const now = performance.now();
  if (now - lastTap_ms < tapDebounce_ms || link === "saving") return;
  lastTap_ms = now;
  if (link === "uncertain" && pending) return send(pending);
  const action = shown?.primary;
  if (!action) return;
  const body = commandFor(action);
  if (!body) return refresh();
  return send({ commandId: crypto.randomUUID(), body });
}

function listen(): void {
  bridge.onEvenHubEvent((event) => {
    const system = event.sysEvent;
    if (!system) return;
    // Protobuf drops zero values, so a single tap arrives with no eventType.
    const type = system.eventType ?? OsEventTypeList.CLICK_EVENT;
    if (type === OsEventTypeList.CLICK_EVENT) void onPrimaryTap();
    else if (type === OsEventTypeList.DOUBLE_CLICK_EVENT) void onBridge(() => bridge.shutDownPageContainer(1));
    else if (type === OsEventTypeList.FOREGROUND_ENTER_EVENT) {
      isForeground = true;
      void refresh();
    } else if (type === OsEventTypeList.FOREGROUND_EXIT_EVENT) isForeground = false;
  });
}

async function pollLoop(): Promise<void> {
  if (isForeground && link !== "saving" && link !== "uncertain") await refresh();
  setTimeout(() => void pollLoop(), pollInterval_ms);
}

bridge = await waitForEvenAppBridge();
await render();
listen();
await pollLoop();
