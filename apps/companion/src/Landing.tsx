// The public page shown when Stow is opened in a browser rather than inside
// Telegram: what Stow is, the loop it runs, real captures, what the Mini App
// covers, and how a team gets started. It is loaded lazily, so the Mini App
// inside Telegram never downloads it.
//
// PRD §14.5 sets the motion: slow coral and deep-blue geometry behind the
// hero and a word-by-word headline. The Telegram → glasses → Telegram strip
// was first pinned and lit by scroll position; that left a dark screen on
// entry and a half-lit last step, so it is now a plain strip that fades in.
// The strip is drawn in the browser and labelled as a simulated preview; every
// other image is a real capture.

import { m, useInView, useReducedMotion } from "motion/react";
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
      <div className="relative mx-auto grid max-w-[1120px] items-center gap-12 px-4 pt-16 pb-24 sm:px-8 sm:pt-24 sm:pb-24 lg:grid-cols-[1fr_1.1fr]">
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
      className="flex flex-col gap-4"
    >
      <div className="relative pr-20 pb-16 sm:pr-32 sm:pb-20">
        <Lens src="landing/glasses-pick.png" alt={text.heroGlassesAlt} isEager />
        {/* Only the top of the Mini App capture has content, so the frame shows that part and fades out. */}
        <div className="absolute right-0 bottom-0 aspect-[9/14] w-[120px] overflow-hidden rounded-[22px] border border-border-strong bg-canvas shadow-[0_30px_60px_-20px_rgba(0,0,0,0.8)] sm:w-[170px] sm:rounded-[26px]">
          <img src="landing/miniapp-orders.jpg" width={450} height={974} alt={text.heroMiniAppAlt} className="w-full" />
          <div aria-hidden="true" className="absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-b from-transparent to-canvas" />
        </div>
      </div>
      <figcaption className="text-[12px] text-text-muted">{text.heroCapture}</figcaption>
    </m.figure>
  );
}

// The G2 draws green on black. A capture framed as a lens, padded so its text
// never meets the edge and lit with a faint green glow, reads as a display
// rather than a black box.
function Lens({ src, alt, isEager = false }: { src: string; alt: string; isEager?: boolean }) {
  return (
    <div className="rounded-[26px] bg-gradient-to-b from-white/20 to-white/[0.04] p-px shadow-[0_30px_90px_-35px_rgba(69,240,122,0.45)]">
      <div className="relative overflow-hidden rounded-[25px] bg-black px-5 py-4 sm:px-7 sm:py-6">
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(69,240,122,0.12),transparent_65%)]" />
        <img src={src} width={576} height={288} loading={isEager ? "eager" : "lazy"} alt={alt} className="relative w-full" />
      </div>
    </div>
  );
}

function Loop() {
  return (
    <section className="mx-auto flex max-w-[1120px] flex-col gap-10 px-4 py-20 sm:px-8 sm:py-24">
      <div className="flex flex-col gap-3">
        <h2 className="text-[32px] leading-tight font-normal sm:text-[40px]">{text.loopTitle}</h2>
        <p className="text-[16px] text-text-secondary">{text.loopLede}</p>
      </div>
      <ol className="grid items-stretch gap-4 lg:grid-cols-[1fr_auto_1fr_auto_1fr]">
        {text.loop.map((step, index) => (
          <LoopStep key={step.label} step={step} index={index} />
        ))}
      </ol>
      <span className="self-start rounded-[var(--radius-badge)] border border-border-strong px-2 py-1 font-mono text-[11px] tracking-[0.04em] text-text-muted">{text.simulated}</span>
    </section>
  );
}

function LoopStep({ step, index }: { step: (typeof text.loop)[number]; index: number }) {
  const isGlasses = index === 1;
  return (
    <>
      {index > 0 && (
        <li aria-hidden="true" className="hidden items-center text-[20px] text-text-muted lg:flex">→</li>
      )}
      <m.li
        initial={{ opacity: 0, y: 16 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: "-80px" }}
        transition={{ delay: index * 0.12, duration: 0.6, ease: [0.2, 0, 0, 1] }}
        className="flex flex-col gap-4 rounded-[var(--radius-card)] border border-border bg-surface/50 p-5 sm:p-6"
      >
        <span className="text-[11px] font-semibold uppercase tracking-[0.073em] text-accent">
          {index + 1} · {step.label}
        </span>
        <span className="text-[19px] font-medium">{step.title}</span>
        {isGlasses ? (
          <pre className="mt-auto rounded-[18px] border border-white/10 bg-black px-5 py-4 font-mono text-[14px] leading-[1.55] text-[#45f07a] shadow-[0_20px_60px_-30px_rgba(69,240,122,0.5)]">{step.body}</pre>
        ) : (
          <pre className="mt-auto self-start rounded-[18px] rounded-bl-[6px] bg-[#1f2937] px-5 py-4 font-sans text-[14px] leading-[1.55] whitespace-pre-wrap text-[#e6edf5]">{step.body}</pre>
        )}
      </m.li>
    </>
  );
}

function Captures() {
  return (
    <section className="mx-auto flex max-w-[1120px] flex-col gap-24 px-4 py-20 sm:px-8 sm:py-28">
      {text.sections.map((section, index) => (
        <Reveal key={section.title} className={`grid items-center gap-10 md:grid-cols-2 md:gap-16 ${index % 2 === 1 ? "md:[&>*:first-child]:order-2" : ""}`}>
          <div className="flex max-w-[460px] flex-col gap-4">
            <span className="font-mono text-[12px] tracking-[0.04em] text-accent">{text.onGlasses(index + 1, text.sections.length)}</span>
            <h2 className="text-[28px] leading-tight font-normal sm:text-[34px]">{section.title}</h2>
            <p className="text-[16px] leading-[1.7] text-text-secondary">{section.body}</p>
          </div>
          <figure className="flex w-full max-w-[520px] flex-col gap-4 md:justify-self-center">
            {section.images.map((image) => (
              <Lens key={image} src={`landing/${image}`} alt="" />
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
