// How to use Stow from the group and the glasses, what each warning screen
// means, and where to report a problem. Plain reference, no promises of
// support that does not exist.

import { copy } from "./copy.ts";
import { BackLink } from "./ui.tsx";

const issues = "https://github.com/gsoffmarket/stow/issues";

export function Help({ onBack }: { onBack: () => void }) {
  const help = copy.help;
  return (
    <section className="flex flex-col gap-6">
      <div className="flex items-center gap-3">
        <BackLink label={help.back} onBack={onBack} />
        <h1 className="text-2xl font-medium">{help.title}</h1>
      </div>
      {help.sections.map((section) => (
        <section key={section.title} className="flex flex-col gap-2.5">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.073em] text-text-secondary">{section.title}</h2>
          <dl className="overflow-hidden rounded-[var(--radius-card)] bg-surface shadow-[var(--shadow-key)]">
            {section.rows.map(([term, meaning], index) => (
              <div key={term} className={`flex flex-col gap-1 px-4 py-3 ${index > 0 ? "border-t border-border" : ""}`}>
                <dt className="font-mono text-[13px]">{term}</dt>
                <dd className="text-[14px] leading-normal text-text-secondary">{meaning}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
      <section className="flex flex-col gap-2">
        <h2 className="text-[17px] font-medium">{help.safetyTitle}</h2>
        <p className="text-[14px] leading-normal text-text-secondary">{help.safety}</p>
      </section>
      <section className="flex flex-col gap-2">
        <h2 className="text-[17px] font-medium">{help.supportTitle}</h2>
        <p className="text-[14px] leading-normal text-text-secondary">{help.support}</p>
        <a href={issues} className="self-start text-[15px] font-medium text-accent">{help.supportLink}</a>
      </section>
    </section>
  );
}
