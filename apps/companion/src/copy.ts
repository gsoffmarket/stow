// Every user-facing string in the Mini App, kept in one place.

export const copy = {
  openFromTelegram: { title: "Open Stow from Telegram", body: "Stow signs you in with your Telegram account. Open it from the Stow bot or your work group." },
  signingIn: "Signing you in…",
  signInFailed: { title: "Could not sign you in", body: "Close Stow and open it again from Telegram.", retry: "Try again" },
  noWorkspace: { title: "You are not in a workspace yet", body: "Ask your owner for an invite link, or send /setup to the Stow bot to start one." },
  home: { greeting: (name: string) => `Hi ${name}`, pair: "Pair glasses", pairHint: "Connect your Even G2 to your picking work." },
  pair: {
    title: "Pair your glasses",
    body: "Open Stow on your G2. Type the code it shows.",
    label: "Code on your glasses",
    workspace: "Pair for",
    submit: "Approve device",
    submitting: "Approving…",
    back: "Back",
    done: (label: string) => `${label} is paired. Your glasses will open your work in a moment.`,
    errors: {
      NOT_FOUND: "That code was not found. Check it on your glasses.",
      PAIRING_EXPIRED: "That code has expired. Your glasses will show a new one.",
      ROLE_REQUIRED: "Only pickers can pair glasses to their work.",
      NETWORK: "No connection. Try again.",
      UNKNOWN: "Something went wrong. Try again.",
    } as Record<string, string>,
  },
} as const;
