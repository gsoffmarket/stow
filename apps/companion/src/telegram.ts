// The parts of Telegram's Mini App object Stow uses. Telegram injects it from
// telegram-web-app.js; outside Telegram it is missing or has empty initData.

type WebApp = {
  initData: string;
  initDataUnsafe: { start_param?: string };
  ready(): void;
  expand(): void;
  setHeaderColor(color: string): void;
  setBackgroundColor(color: string): void;
  openTelegramLink?(url: string): void;
  BackButton?: { show(): void; hide(): void; onClick(handler: () => void): void; offClick(handler: () => void): void };
  HapticFeedback?: {
    impactOccurred(style: "light" | "medium" | "heavy"): void;
    notificationOccurred(type: "success" | "warning" | "error"): void;
  };
};

declare global {
  interface Window {
    Telegram?: { WebApp?: WebApp };
  }
}

const app = (): WebApp | null => (window.Telegram?.WebApp?.initData ? window.Telegram.WebApp : null);

/** launchData is Telegram's signed launch data, or null outside Telegram. */
export function launchData(): string | null {
  return app()?.initData ?? null;
}

/** startParam is the value after ?startapp= in the link that opened the Mini App. */
export function startParam(): string | null {
  return app()?.initDataUnsafe.start_param ?? null;
}

/** startOrder is the order an "Open in Stow" link names, or null. */
export function startOrder(): string | null {
  return /^order_([0-9a-f-]{36})$/.exec(startParam() ?? "")?.[1] ?? null;
}

/** prepare tells Telegram the app is ready and paints its frame in Stow's canvas color. */
export function prepare(canvas: string): void {
  const webApp = app();
  if (!webApp) return;
  webApp.ready();
  webApp.expand();
  webApp.setHeaderColor(canvas);
  webApp.setBackgroundColor(canvas);
}

/**
 * nativeBack shows Telegram's own back button while a page is open and runs
 * onBack when it is pressed. It returns the cleanup for the page to call when
 * it closes, or null outside Telegram, where the page draws its own button.
 */
export function nativeBack(onBack: () => void): (() => void) | null {
  const button = app()?.BackButton;
  if (!button) return null;
  button.onClick(onBack);
  button.show();
  return () => {
    button.offClick(onBack);
    button.hide();
  };
}

/** haptic plays feedback for an outcome that has already happened, never before. */
export function haptic(kind: "tap" | "success" | "error"): void {
  const feedback = app()?.HapticFeedback;
  if (!feedback) return;
  if (kind === "tap") feedback.impactOccurred("light");
  else feedback.notificationOccurred(kind);
}

/** botLink is the chat with Stow's bot, or null when the build does not know the bot. */
export const botLink = (() => {
  const username = (import.meta.env.VITE_STOW_BOT_USERNAME as string | undefined) || null;
  return username ? `https://t.me/${username}` : null;
})();

/**
 * openBot opens the bot's chat. Inside Telegram it switches chats without
 * closing the Mini App; a plain link would leave Telegram for the browser.
 */
export function openBot(): void {
  if (!botLink) return;
  const webApp = app();
  if (webApp?.openTelegramLink) webApp.openTelegramLink(botLink);
  else window.open(botLink, "_blank", "noopener");
}
