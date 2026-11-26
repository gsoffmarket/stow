// The Mini App shell: sign in with Telegram's launch data, then show what
// this person can do. Opening it with ?startapp=pair goes straight to pairing,
// and ?startapp=order_<id> straight to that order.
// Opened in a browser instead of Telegram, the same address is Stow's public
// landing page, or at /docs the guide, each loaded separately so the Mini App
// stays small.

import { lazy, Suspense, useEffect, useState } from "react";
import { signIn, type Session } from "./api.ts";
import { copy } from "./copy.ts";
import { Catalogue } from "./Catalogue.tsx";
import { OrderDetail } from "./OrderDetail.tsx";
import { Orders } from "./Orders.tsx";
import { Help } from "./Help.tsx";
import { Pair } from "./Pair.tsx";
import { Reports } from "./Reports.tsx";
import { Sessions } from "./Sessions.tsx";
import { Settings } from "./Settings.tsx";
import { SetupChecklist } from "./SetupChecklist.tsx";
import { Team } from "./Team.tsx";
import { TelegramSetup } from "./TelegramSetup.tsx";
import { launchData, openBot, startOrder, startParam } from "./telegram.ts";
import { Card, GhostButton, Mark, Page, PrimaryButton } from "./ui.tsx";

const Landing = lazy(() => import("./Landing.tsx"));
const Docs = lazy(() => import("./Docs.tsx"));

type State = { kind: "outside" } | { kind: "signing-in" } | { kind: "failed" } | { kind: "ready"; session: Session };

export function App() {
  const [state, setState] = useState<State>(() => (launchData() ? { kind: "signing-in" } : { kind: "outside" }));
  const [view, setView] = useState<"home" | "pair">(() => (startParam() === "pair" ? "pair" : "home"));
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const data = launchData();
    if (!data) return;
    let cancelled = false;
    signIn(data)
      .then((session) => !cancelled && setState({ kind: "ready", session }))
      .catch(() => !cancelled && setState({ kind: "failed" }));
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  if (state.kind === "outside") {
    return (
      <Suspense fallback={null}>
        {location.pathname === "/docs" ? <Docs /> : <Landing />}
      </Suspense>
    );
  }

  return (
    <Page>
      <header className="flex items-center gap-2.5">
        <Mark />
        <span className="text-[15px] font-semibold tracking-[0.01em]">Stow</span>
      </header>
      {state.kind === "signing-in" && <p className="text-text-secondary" role="status">{copy.signingIn}</p>}
      {state.kind === "failed" && (
        <Message title={copy.signInFailed.title} body={copy.signInFailed.body}>
          <GhostButton onClick={() => { setState({ kind: "signing-in" }); setAttempt((n) => n + 1); }}>{copy.signInFailed.retry}</GhostButton>
        </Message>
      )}
      {state.kind === "ready" && <Signed session={state.session} view={view} setView={setView} />}
    </Page>
  );
}

function Signed({ session, view, setView }: { session: Session; view: "home" | "pair"; setView: (view: "home" | "pair") => void }) {
  // An "Open in Stow" link from a group status message opens straight on its order.
  const [openOrder, setOpenOrder] = useState<string | null>(startOrder);
  const [page, setPage] = useState<"orders" | "catalogue" | "team" | "sessions" | "telegram" | "reports" | "settings" | "help">("orders");
  const pickers = session.memberships.filter((m) => m.role === "PICKER" || m.role === "OWNER");
  const coordinates = session.memberships.find((m) => m.role === "COORDINATOR" || m.role === "OWNER");
  if (session.memberships.length === 0) return <Message title={copy.noWorkspace.title} body={copy.noWorkspace.body} />;
  if (view === "pair" && pickers.length > 0) return <Pair token={session.token} workspaces={pickers} onBack={() => setView("home")} />;
  if (page === "help") return <Help onBack={() => setPage("orders")} />;
  if (coordinates && page === "catalogue") {
    return <Catalogue token={session.token} workspaceId={coordinates.workspaceId} onBack={() => setPage("orders")} />;
  }
  if (coordinates && page === "reports") {
    return <Reports token={session.token} workspaceId={coordinates.workspaceId} onBack={() => setPage("orders")} />;
  }
  if (coordinates && page === "sessions") {
    return <Sessions token={session.token} workspaceId={coordinates.workspaceId} onBack={() => setPage("orders")} />;
  }
  if (coordinates && page === "settings") {
    return <Settings token={session.token} workspaceId={coordinates.workspaceId} isOwner={coordinates.role === "OWNER"} onBack={() => setPage("orders")} />;
  }
  if (coordinates && page === "telegram") {
    return <TelegramSetup token={session.token} workspaceId={coordinates.workspaceId} isOwner={coordinates.role === "OWNER"} onBack={() => setPage("orders")} />;
  }
  if (coordinates && page === "team") {
    return <Team token={session.token} workspaceId={coordinates.workspaceId} isOwner={coordinates.role === "OWNER"} onBack={() => setPage("orders")} />;
  }
  if (coordinates && openOrder) {
    return <OrderDetail token={session.token} workspaceId={coordinates.workspaceId} orderId={openOrder} onBack={() => setOpenOrder(null)} />;
  }
  if (coordinates) {
    return (
      <>
        <SetupChecklist
          token={session.token}
          workspaceId={coordinates.workspaceId}
          canPair={pickers.length > 0}
          onGo={(destination) => (destination === "pair" ? setView("pair") : destination === "bot" ? openBot() : setPage(destination))}
        />
        <Orders token={session.token} workspaceId={coordinates.workspaceId} onOpen={setOpenOrder} />
        <nav className="grid grid-cols-2 gap-2">
          <GhostButton onClick={() => setPage("catalogue")}>{copy.catalogue.open}</GhostButton>
          <GhostButton onClick={() => setPage("team")}>{copy.team.open}</GhostButton>
          <GhostButton onClick={() => setPage("sessions")}>{copy.sessions.open}</GhostButton>
          <GhostButton onClick={() => setPage("telegram")}>{copy.telegram.open}</GhostButton>
          <GhostButton onClick={() => setPage("reports")}>{copy.reports.open}</GhostButton>
          <GhostButton onClick={() => setPage("settings")}>{copy.settings.open}</GhostButton>
          <GhostButton onClick={() => setPage("help")}>{copy.help.open}</GhostButton>
          {pickers.length > 0 && <GhostButton onClick={() => setView("pair")}>{copy.orders.pairGlasses}</GhostButton>}
        </nav>
      </>
    );
  }
  return (
    <Card>
      <h1 className="text-2xl font-medium">{copy.home.greeting(session.user.firstName)}</h1>
      <ul className="flex flex-col gap-2">
        {session.memberships.map((m) => (
          <li key={m.workspaceId} className="flex items-center justify-between rounded-[var(--radius-control)] bg-surface-recessed px-4 py-3">
            <span className="text-[15px]">{m.workspaceName}</span>
            <span className="rounded-[var(--radius-badge)] bg-surface-raised px-2 py-0.5 text-[11px] font-semibold tracking-[0.04em] text-text-secondary">{m.role}</span>
          </li>
        ))}
      </ul>
      {pickers.length > 0 && (
        <div className="flex flex-col gap-2">
          <PrimaryButton onClick={() => setView("pair")}>{copy.home.pair}</PrimaryButton>
          <p className="text-[13px] text-text-muted">{copy.home.pairHint}</p>
        </div>
      )}
      <GhostButton onClick={() => setPage("help")}>{copy.help.open}</GhostButton>
    </Card>
  );
}

function Message({ title, body, children }: { title: string; body: string; children?: React.ReactNode }) {
  return (
    <Card>
      <h1 className="text-2xl font-medium">{title}</h1>
      <p className="text-[15px] leading-normal text-text-secondary">{body}</p>
      {children}
    </Card>
  );
}
