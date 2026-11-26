// The public guide at /docs: setting Stow up in order, then reference
// sections to come back to. Like the landing page it is only shown outside
// Telegram and loaded lazily. The gesture, command, warning and privacy rows
// are the same copy the Mini App's Help and Settings pages show, so the two
// cannot drift apart.

import { useEffect, type ReactNode } from "react";
import { copy } from "./copy.ts";
import { Mark } from "./ui.tsx";

const repository = "https://github.com/gsoffmarket/stow";
const issues = `${repository}/issues`;
const text = copy.docs;
const [groupCommands, glassesGestures, stopScreens] = copy.help.sections;

const contents: readonly { id: string; title: string }[] = [
  { id: "overview", title: text.places.title },
  ...text.steps.map((step, index) => ({ id: step.id, title: `${index + 1}. ${step.title}` })),
  text.gestures,
  text.commands,
  text.pages,
  text.screens,
  text.troubleshooting,
  text.data,
  { id: "support", title: copy.help.supportTitle },
];

export default function Docs() {
  useEffect(() => {
    document.title = text.title;
    // The page loads after the browser looked for the #section in the link, so go there now.
    if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
  }, []);
  return (
    <div id="top" className="min-h-dvh bg-canvas text-text-primary">
      <nav className="mx-auto flex max-w-[1120px] items-center gap-2.5 px-4 py-5 sm:px-8">
        <a href="/" className="flex items-center gap-2.5">
          <Mark />
          <span className="text-[15px] font-semibold tracking-[0.01em]">Stow</span>
        </a>
        <span className="text-[15px] text-text-muted">{text.nav}</span>
        <a href={repository} className="ml-auto text-[14px] text-text-secondary hover:text-text-primary">{copy.landing.source}</a>
      </nav>

      <header className="mx-auto flex max-w-[1120px] flex-col gap-4 px-4 pt-8 sm:px-8 md:pl-[calc(2rem+200px+3.5rem)]">
        <h1 className="text-[36px] leading-tight font-normal sm:text-[44px]">{text.title}</h1>
        <p className="max-w-[720px] text-[17px] leading-[1.6] text-text-secondary">{text.lede}</p>
      </header>

      <div className="mx-auto grid max-w-[1120px] gap-10 px-4 pt-10 pb-20 sm:px-8 md:grid-cols-[200px_minmax(0,1fr)] md:gap-14">
        {/* A phone gets the contents folded away so the guide starts on screen; wider screens keep them beside it. */}
        <details className="rounded-[var(--radius-card)] border border-border px-4 py-3 md:hidden">
          <summary className="cursor-pointer text-[14px] font-medium">{text.contents}</summary>
          <Contents />
        </details>
        <aside className="hidden md:sticky md:top-8 md:block md:self-start">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.073em] text-text-secondary">{text.contents}</h2>
          <Contents />
        </aside>

        <main className="flex max-w-[720px] flex-col gap-16">

          <Topic id="overview" title={text.places.title}>
            <Paragraph>{text.places.body}</Paragraph>
            <Rows rows={text.places.rows} />
          </Topic>

          <section className="flex flex-col gap-12">
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.073em] text-accent">{text.setupTitle}</h2>
            {text.steps.map((step, index) => (
              <article key={step.id} id={step.id} className="flex scroll-mt-8 gap-4">
                <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-full border border-border-strong font-mono text-[13px]">{index + 1}</span>
                <div className="flex min-w-0 flex-col gap-3">
                  <h3 className="text-[22px] leading-tight font-normal">{step.title}</h3>
                  {step.body.map((paragraph) => <Paragraph key={paragraph}>{paragraph}</Paragraph>)}
                  {"code" in step && <Code>{step.code}</Code>}
                  {"note" in step && <p className="text-[14px] leading-[1.6] text-text-muted">{step.note}</p>}
                </div>
              </article>
            ))}
          </section>

          <h2 className="-mb-8 text-[11px] font-semibold uppercase tracking-[0.073em] text-accent">{text.referenceTitle}</h2>
          <Topic id={text.gestures.id} title={text.gestures.title}>
            <Rows rows={glassesGestures!.rows} />
          </Topic>
          <Topic id={text.commands.id} title={text.commands.title}>
            <Paragraph>{text.commands.body}</Paragraph>
            <Rows rows={groupCommands!.rows} />
          </Topic>
          <Topic id={text.pages.id} title={text.pages.title}>
            <Rows rows={text.pages.rows} />
          </Topic>
          <Topic id={text.screens.id} title={text.screens.title}>
            <Rows rows={stopScreens!.rows} />
            <Paragraph>{copy.help.safety}</Paragraph>
          </Topic>
          <Topic id={text.troubleshooting.id} title={text.troubleshooting.title}>
            <Rows rows={text.troubleshooting.rows} />
          </Topic>
          <Topic id={text.data.id} title={text.data.title}>
            <ul className="flex list-disc flex-col gap-2 pl-5 text-[15px] leading-[1.6] text-text-secondary">
              {copy.settings.privacy.map((line) => <li key={line}>{line}</li>)}
            </ul>
            <Paragraph>{text.data.body}</Paragraph>
            <Paragraph>{copy.settings.deletion}</Paragraph>
          </Topic>
          <Topic id="support" title={copy.help.supportTitle}>
            <Paragraph>{text.supportBody}</Paragraph>
            <a href={issues} className="self-start text-[15px] font-medium text-accent hover:underline">{copy.help.supportLink}</a>
          </Topic>

          <a href="#top" className="self-start text-[14px] text-text-secondary hover:text-text-primary">{text.toTop}</a>
        </main>
      </div>
      <footer className="mx-auto max-w-[1120px] border-t border-border px-4 py-10 text-[13px] text-text-muted sm:px-8">{copy.landing.footer}</footer>
    </div>
  );
}

function Contents() {
  return (
    <ol className="mt-3 flex flex-col gap-2 text-[14px]">
      {contents.map((entry) => (
        <li key={entry.id}>
          <a href={`#${entry.id}`} className="text-text-secondary hover:text-text-primary">{entry.title}</a>
        </li>
      ))}
    </ol>
  );
}

function Topic({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="flex scroll-mt-8 flex-col gap-4">
      <h2 className="text-[26px] leading-tight font-normal">{title}</h2>
      {children}
    </section>
  );
}

function Paragraph({ children }: { children: ReactNode }) {
  return <p className="text-[15px] leading-[1.6] text-text-secondary">{children}</p>;
}

function Code({ children }: { children: string }) {
  return <pre className="overflow-x-auto rounded-[var(--radius-control)] border border-border bg-surface-recessed px-4 py-3 font-mono text-[13px] leading-[1.7]">{children}</pre>;
}

function Rows({ rows }: { rows: readonly (readonly [string, string])[] }) {
  return (
    <dl className="overflow-hidden rounded-[var(--radius-card)] bg-surface shadow-[var(--shadow-key)]">
      {rows.map(([term, meaning], index) => (
        <div key={term} className={`flex flex-col gap-1 px-4 py-3 sm:flex-row sm:gap-6 ${index > 0 ? "border-t border-border" : ""}`}>
          <dt className="font-mono text-[13px] sm:w-[220px] sm:shrink-0">{term}</dt>
          <dd className="text-[14px] leading-normal text-text-secondary">{meaning}</dd>
        </div>
      ))}
    </dl>
  );
}
