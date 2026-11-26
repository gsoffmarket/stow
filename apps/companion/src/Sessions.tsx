// Who has glasses on and what they hold. View only: the server decides
// whether a device is connected, on its own clock, and a device that goes
// quiet keeps its orders on screen, because its picker may still hold goods.

import { m } from "motion/react";
import { listSessions, type GlassesSession } from "./api.ts";
import { copy } from "./copy.ts";
import { LiveDot } from "./Orders.tsx";
import { usePolling } from "./polling.ts";
import { BackLink } from "./ui.tsx";

type Props = { token: string; workspaceId: string; onBack: () => void };

const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

// "5 minutes ago", in the largest unit that keeps the number small.
function ago(at: string): string {
  const seconds = Math.round((Date.parse(at) - Date.now()) / 1000);
  if (seconds > -3600) return relative.format(Math.round(seconds / 60), "minute");
  if (seconds > -86_400) return relative.format(Math.round(seconds / 3600), "hour");
  return relative.format(Math.round(seconds / 86_400), "day");
}

export function Sessions({ token, workspaceId, onBack }: Props) {
  const { data, isLive } = usePolling(() => listSessions(token, workspaceId), [workspaceId], 10_000);

  return (
    <section className="flex flex-col gap-5">
      <div className="flex items-center gap-3">
        <BackLink label={copy.sessions.back} onBack={onBack} />
        <h1 className="mr-auto text-2xl font-medium">{copy.sessions.title}</h1>
        <LiveDot isLive={isLive} />
      </div>

      {data?.sessions.length === 0 && <p className="py-6 text-center text-[14px] text-text-muted">{copy.sessions.empty}</p>}
      {data && data.sessions.length > 0 && (
        <ul className="overflow-hidden rounded-[var(--radius-card)] bg-surface shadow-[var(--shadow-key)]">
          {data.sessions.map((session, index) => (
            <li key={session.id} className={`flex flex-col gap-1 px-4 py-3 ${index > 0 ? "border-t border-border" : ""}`}>
              <span className="flex items-center justify-between gap-3">
                <span className="truncate text-[15px]">{session.picker}</span>
                <Presence session={session} />
              </span>
              <span className="truncate text-[12px] text-text-secondary">
                {[session.label, session.orders.length > 0 ? copy.sessions.holding(session.orders) : copy.sessions.free].join(" · ")}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="text-[13px] leading-normal text-text-muted">{copy.sessions.hint}</p>
    </section>
  );
}

function Presence({ session }: { session: GlassesSession }) {
  if (session.isConnected) {
    return (
      <span className="flex shrink-0 items-center gap-1.5 text-[12px] text-confirmed">
        <m.span aria-hidden="true" className="size-[7px] rounded-full bg-confirmed" animate={{ opacity: [1, 0.35, 1] }} transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut" }} />
        {copy.sessions.connected}
      </span>
    );
  }
  // A quiet device that still holds orders is the one a coordinator should look at.
  const tone = session.orders.length > 0 ? "text-pending" : "text-text-muted";
  return <span className={`shrink-0 text-[12px] ${tone}`}>{session.lastSeenAt ? copy.sessions.lastSeen(ago(session.lastSeenAt)) : copy.sessions.neverSeen}</span>;
}
