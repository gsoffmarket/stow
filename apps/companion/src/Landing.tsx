// The public page shown when Stow is opened in a browser rather than inside
// Telegram: what Stow is, the loop it runs, real captures, what the Mini App
// covers, and how a team gets started. It is loaded lazily, so the Mini App inside Telegram never
// downloads it.
//
// PRD §14.5 sets the motion: slow coral and deep-blue geometry behind the
// hero, a word-by-word headline, and a scroll-linked strip walking the
// Telegram → glasses → Telegram loop. The strip is drawn in the browser, so it
// is labelled as a simulated preview; the captures below it are real.

import { m, useInView, useReducedMotion, useScroll, useTransform, type MotionValue } from "motion/react";
import { useRef, type ReactNode } from "react";
import { copy } from "./copy.ts";
import { Mark } from "./ui.tsx";

const repository = "https://github.com/gsoffmarket/stow";
const botUsername = (import.meta.env.VITE_STOW_BOT_USERNAME as string | undefined) || null;
const text = copy.landing;

export default function Landing() {
  return (
    <div className="min-h-dvh bg-canvas text-text-primary">
      <nav className="mx-auto flex max-w-[1120px] items-center gap-2.5 px-4 py-5 sm:px-8">
        <Mark />
        <span className="text-[15px] font-semibold tracking-[0.01em]">Stow</span>
        <a href="/docs" className="ml-auto text-[14px] text-text-secondary hover:text-text-primary">{copy.docs.nav}</a>
        <a href={repository} className="ml-4 text-[14px] text-text-secondary hover:text-text-primary">{text.source}</a>
      </nav>
      <Hero />
      <Loop />
      <Captures />
      <Console />
      <Features />
      <Facts />
      <Start />
      <footer className="mx-auto flex max-w-[1120px] flex-col gap-4 border-t border-border px-4 py-10 text-[13px] text-text-muted sm:px-8">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-[14px] text-text-secondary">
          <span className="flex items-center gap-2 text-text-primary"><Mark /> Stow</span>
          <a href="/docs" className="hover:text-text-primary">{copy.docs.nav}</a>
          {botUsername && <a href={`https://t.me/${botUsername}`} className="hover:text-text-primary">@{botUsername}</a>}
          <a href={repository} className="hover:text-text-primary">{text.source}</a>
        </div>
        <p>{text.footer}</p>
      </footer>
    </div>
  );
}

function Hero() {
  const ref = useRef<HTMLElement>(null);
  // The drift pauses when the hero scrolls away, so it costs nothing below the fold.
  const isVisible = useInView(ref);
  const isStill = useReducedMotion() ?? false;
  const drift = (x: number, y: number, seconds: number) =>
    isVisible && !isStill ? { x: [0, x, 0], y: [0, y, 0], transition: { duration: seconds, repeat: Infinity, ease: "easeInOut" as const } } : {};
  return (
    <section ref={ref} className="relative overflow-hidden">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0">
        <m.div animate={drift(60, 30, 32)} className="absolute -top-40 right-[-10%] size-[520px] rounded-full bg-[#ff6363] opacity-35 blur-[120px]" />
        <m.div animate={drift(-50, 40, 38)} className="absolute top-20 right-[20%] size-[440px] rounded-full bg-[#63a1ff] opacity-25 blur-[120px]" />
        <m.div animate={drift(40, -30, 26)} className="absolute -bottom-40 left-[-10%] size-[560px] rounded-full bg-[#143ca3] opacity-40 blur-[140px]" />
        <div className="absolute inset-x-0 bottom-0 h-40 bg-gradient-to-b from-transparent to-canvas" />
      </div>
      <div className="relative mx-auto grid max-w-[1120px] items-center gap-12 px-4 pt-16 pb-24 sm:px-8 sm:pt-24 sm:pb-32 lg:grid-cols-[1.1fr_1fr]">
        <div className="flex flex-col gap-6">
          <span className="text-[12px] font-semibold uppercase tracking-[0.073em] text-accent">{text.tagline}</span>
          <h1 className="max-w-[760px] text-[40px] leading-[1.12] font-normal tracking-[0.004em] sm:text-[56px] sm:leading-[1.17]">
            {text.headline.split(" ").map((word, index) => (
              <m.span
                key={`${word}-${index}`}
                className="inline-block"
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: index * 0.04, duration: 0.6, ease: [0.2, 0, 0, 1] }}
              >
                {word}&nbsp;
              </m.span>
            ))}
          </h1>
          <p className="max-w-[620px] text-[17px] leading-[1.6] text-text-secondary">{text.lede}</p>
          <div className="flex flex-wrap gap-3 pt-2">
            {botUsername && (
              <a href={`https://t.me/${botUsername}`} className="flex min-h-11 items-center rounded-[var(--radius-control)] bg-action px-5 text-[15px] font-medium text-action-text shadow-[var(--shadow-lift)]">
                {text.openBot(botUsername)}
              </a>
            )}
            <a href="/docs" className="flex min-h-11 items-center rounded-[var(--radius-control)] border border-border-strong px-5 text-[15px] font-medium">
              {text.readDocs}
            </a>
          </div>
        </div>
        <HeroCaptures />
      </div>
    </section>
  );
}

// Real captures, not drawings: what the picker sees on the glasses and what
// the coordinator sees in Telegram, so the first screen shows the product.
function HeroCaptures() {
  return (
    <m.figure
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.3, duration: 0.8, ease: [0.2, 0, 0, 1] }}
      className="flex flex-col gap-3"
    >
      <div className="relative pr-16 pb-20 sm:pr-24 sm:pb-24">
        <div className="rounded-[28px] border border-border-strong bg-black p-3 shadow-[0_40px_120px_-30px_rgba(255,99,99,0.45)]">
          <img src="landing/glasses-pick.png" width={576} height={288} alt={text.heroGlassesAlt} className="w-full rounded-[18px]" />
        </div>
        <img
          src="landing/miniapp-orders.jpg"
          width={450}
          height={974}
          alt={text.heroMiniAppAlt}
          className="absolute right-0 bottom-0 w-[110px] rounded-[18px] border border-border-strong shadow-[var(--shadow-lift)] sm:w-[150px] sm:rounded-[22px]"
        />
      </div>
      <figcaption className="text-[12px] text-text-muted">{text.heroCapture}</figcaption>
    </m.figure>
  );
}

// From tablet width up, a tall section pins the strip while the page scrolls,
// so scrolling walks the three steps in order. On a phone the stacked steps
// are taller than the screen, so they scroll normally and light up as they pass.
function Loop() {
  const ref = useRef<HTMLElement>(null);
  const isStill = useReducedMotion() ?? false;
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start start", "end end"] });
  return (
    <section ref={ref} className={isStill ? "" : "md:h-[200vh]"}>
      <div className={`${isStill ? "" : "md:sticky md:top-0 md:min-h-dvh"} mx-auto flex max-w-[1120px] flex-col justify-center gap-8 px-4 py-16 sm:px-8`}>
        <div className="flex flex-col gap-2">
          <h2 className="text-[32px] leading-tight font-normal sm:text-[40px]">{text.loopTitle}</h2>
          <p className="text-[16px] text-text-secondary">{text.loopLede}</p>
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          {text.loop.map((step, index) => (
            <LoopStep key={step.label} step={step} index={index} progress={scrollYProgress} isStill={isStill} />
          ))}
        </div>
        <span className="self-start rounded-[var(--radius-badge)] border border-border-strong px-2 py-1 font-mono text-[11px] tracking-[0.04em] text-text-muted">{text.simulated}</span>
      </div>
    </section>
  );
}

function LoopStep({ step, index, progress, isStill }: { step: (typeof text.loop)[number]; index: number; progress: MotionValue<number>; isStill: boolean }) {
  // Each step lights up in its third of the scroll and stays lit after.
  const start = index / 3;
  const opacity = useTransform(progress, [start, start + 0.15], [0.25, 1]);
  const y = useTransform(progress, [start, start + 0.15], [24, 0]);
  const isGlasses = index === 1;
  return (
    <m.div style={isStill ? {} : { opacity, y }} className="flex flex-col gap-3">
      <span className="text-[11px] font-semibold uppercase tracking-[0.073em] text-text-secondary">
        {index + 1} · {step.label}
      </span>
      <span className="text-[19px] font-medium">{step.title}</span>
      {isGlasses ? (
        <pre className="aspect-[2/1] overflow-hidden rounded-[var(--radius-card)] border border-border bg-black p-5 font-mono text-[15px] leading-[1.5] text-[#45f07a]">{step.body}</pre>
      ) : (
        <pre className="rounded-[18px] rounded-bl-[6px] bg-[#1f2937] px-5 py-4 font-sans text-[15px] leading-[1.5] whitespace-pre-wrap text-[#e6edf5]">{step.body}</pre>
      )}
    </m.div>
  );
}

function Captures() {
  return (
    <section className="mx-auto flex max-w-[1120px] flex-col gap-20 px-4 py-20 sm:px-8 sm:py-28">
      {text.sections.map((section, index) => (
        <Reveal key={section.title} className={`grid items-center gap-8 md:grid-cols-2 ${index % 2 === 1 ? "md:[&>*:first-child]:order-2" : ""}`}>
          <div className="flex flex-col gap-3">
            <h2 className="text-[28px] leading-tight font-normal sm:text-[32px]">{section.title}</h2>
            <p className="text-[16px] leading-[1.6] text-text-secondary">{section.body}</p>
          </div>
          <figure className="flex flex-col gap-3">
            {section.images.map((image) => (
              <img key={image} src={`landing/${image}`} width={576} height={288} loading="lazy" alt="" className="w-full rounded-[var(--radius-card)] border border-border" />
            ))}
            <figcaption className="text-[12px] text-text-muted">{text.capture}</figcaption>
          </figure>
        </Reveal>
      ))}
    </section>
  );
}

function Console() {
  return (
    <section className="border-y border-border bg-surface/40">
      <Reveal className="mx-auto grid max-w-[1120px] items-center gap-10 px-4 py-20 sm:px-8 md:grid-cols-[1fr_auto]">
        <div className="flex max-w-[520px] flex-col gap-3">
          <h2 className="text-[28px] leading-tight font-normal sm:text-[32px]">{text.consoleTitle}</h2>
          <p className="text-[16px] leading-[1.6] text-text-secondary">{text.consoleBody}</p>
        </div>
        <figure className="flex flex-col gap-3">
          <div className="flex gap-3">
            {["miniapp-orders.jpg", "miniapp-revise.jpg"].map((image) => (
              <img key={image} src={`landing/${image}`} width={450} height={974} loading="lazy" alt="" className="w-[150px] rounded-[18px] border border-border sm:w-[200px]" />
            ))}
          </div>
          <figcaption className="text-[12px] text-text-muted">{text.miniAppCapture}</figcaption>
        </figure>
      </Reveal>
    </section>
  );
}

function Facts() {
  return (
    <section className="mx-auto grid max-w-[1120px] gap-12 px-4 py-20 sm:px-8 md:grid-cols-2">
      <Reveal className="flex flex-col gap-4">
        <h2 className="text-[24px] font-normal">{text.whoTitle}</h2>
        <ul className="flex flex-col gap-3 text-[15px] leading-[1.6] text-text-secondary">
          {text.who.map((line) => <li key={line}>{line}</li>)}
        </ul>
      </Reveal>
      <Reveal className="flex flex-col gap-4">
        <h2 className="text-[24px] font-normal">{text.verifiedTitle}</h2>
        <ul className="flex flex-col gap-3 text-[15px] leading-[1.6] text-text-secondary">
          {text.verified.map((line) => <li key={line}>{line}</li>)}
        </ul>
      </Reveal>
    </section>
  );
}

function Features() {
  return (
    <section className="mx-auto flex max-w-[1120px] flex-col gap-10 px-4 pt-20 sm:px-8 sm:pt-28">
      <div className="flex max-w-[620px] flex-col gap-3">
        <h2 className="text-[28px] leading-tight font-normal sm:text-[32px]">{text.featuresTitle}</h2>
        <p className="text-[16px] leading-[1.6] text-text-secondary">{text.featuresLede}</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {text.features.map((feature) => (
          <Reveal key={feature.title} className="flex h-full flex-col gap-2 rounded-[var(--radius-card)] border border-border bg-surface/60 p-5">
            <h3 className="text-[17px] font-medium">{feature.title}</h3>
            <p className="text-[14px] leading-[1.6] text-text-secondary">{feature.body}</p>
          </Reveal>
        ))}
      </div>
    </section>
  );
}

function Start() {
  return (
    <section className="mx-auto flex max-w-[1120px] flex-col gap-16 px-4 pb-20 sm:px-8">
      <Reveal className="flex flex-col gap-8 rounded-[var(--radius-card)] border border-border bg-surface/40 p-6 sm:p-10">
        <div className="flex flex-col gap-3">
          <h2 className="text-[28px] font-normal sm:text-[32px]">{text.startTitle}</h2>
          <p className="max-w-[620px] text-[16px] leading-[1.6] text-text-secondary">{text.startLede}</p>
        </div>
        <ol className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {text.start.map((step, index) => (
            <li key={step.title} className="flex flex-col gap-2">
              <span aria-hidden="true" className="grid size-8 place-items-center rounded-full border border-border-strong font-mono text-[13px]">{index + 1}</span>
              <span className="text-[16px] font-medium">{step.title}</span>
              <span className="text-[14px] leading-[1.6] text-text-secondary">{step.body}</span>
            </li>
          ))}
        </ol>
        <div className="flex flex-wrap gap-3">
          {botUsername && (
            <a href={`https://t.me/${botUsername}`} className="flex min-h-11 items-center rounded-[var(--radius-control)] bg-action px-5 text-[15px] font-medium text-action-text">
              {text.openBot(botUsername)}
            </a>
          )}
          <a href="/docs" className="flex min-h-11 items-center rounded-[var(--radius-control)] border border-border-strong px-5 text-[15px] font-medium">{text.fullGuide}</a>
        </div>
      </Reveal>
      <div className="flex flex-col gap-5">
        <h2 className="text-[24px] font-normal">{text.tryTitle}</h2>
        <p className="max-w-[620px] text-[16px] leading-[1.6] text-text-secondary">{text.tryBody}</p>
        <pre className="overflow-x-auto rounded-[var(--radius-card)] border border-border bg-surface-recessed p-4 font-mono text-[13px] leading-[1.7]">{text.tryCommands}</pre>
        <a href={repository} className="self-start text-[15px] font-medium text-accent hover:underline">{text.source}</a>
        <p className="max-w-[620px] text-[13px] leading-[1.6] text-text-muted">{text.scope}</p>
      </div>
    </section>
  );
}

// Fades a block in once as it scrolls into view.
function Reveal({ className, children }: { className: string; children: ReactNode }) {
  return (
    <m.div className={className} initial={{ opacity: 0, y: 16 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: "-80px" }} transition={{ duration: 0.6, ease: [0.2, 0, 0, 1] }}>
      {children}
    </m.div>
  );
}
