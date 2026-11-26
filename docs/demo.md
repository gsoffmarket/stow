# Demo run sheet

A two-minute film of the live loop: a real Telegram group on the left, the official Even Hub simulator on the right. Every step below is a real action against a deployed Stow; nothing is mocked or sped up.

## Before recording

1. Deploy (see [deploy.md](deploy.md)) and connect a bot to a private test group. Use `/setup`, `/stow_connect`, and `/invite picker` for a second Telegram account.
2. Import the catalogue in the Mini App (Orders → Catalogue → Import CSV):

   ```csv
   sku,name,bin,route_rank
   TS-BLK-M,Black T-shirt (M),A-03,1
   CP-WHT,White cap,B-11,2
   TB-NAT,Natural tote bag,C-02,3
   ```

3. Start the simulator against the deployed glasses app and pair it from the picker's Mini App:

   ```bash
   pnpm --filter @stow/glasses exec evenhub-simulator https://YOUR_HOST/glasses/ --automation-port 9898
   ```

4. Screen layout: Telegram desktop on the left half, the simulator on the right, and the Mini App on a phone or a narrow window for beat 6.
5. Put this label on screen for the whole film: **"Even Hub simulator 0.9.5 — not tested on physical G2."**

## Beats

| # | Time | On screen | Do | Caption |
|---|---|---|---|---|
| 1 | 0–9 s | A person at a shelf, both hands holding stock (label it "illustrative") | — | Picking an order means both hands are full. |
| 2 | 9–18 s | Telegram group, a stream of orders and changes | — | In small stockrooms, orders and changes live in a Telegram group. |
| 3 | 18–23 s | Title card: Stow | — | Stow: your work group's orders on your glasses. |
| 4 | 23–32 s | Coordinator posts an order; the glasses show it | Send `/order` with `TS-BLK-M x 3`, `CP-WHT x 2`, `TB-NAT x 1`. Tap to start. | An order posted in the group becomes one instruction at a time. |
| 5 | 32–45 s | Pick and the group's status message updating | Tap once on `PICK × 3`. Point at the status message changing to `3/6`. | One tap confirms what's in the tote. The group sees it. |
| 6 | 45–58 s | The surprise: the coordinator changes an order already picked | Send `/revise ST-… TS-BLK-M 1`, tap **Confirm**. Glasses: `STOP — ORDER CHANGED`, tap, `RETURN × 2`, tap. | Changed after picking? Stow asks for the extra back first, never a silent overwrite. |
| 7 | 58–72 s | Shortage, decided in Telegram | Glasses: swipe → **Report shortage**. Telegram: tap **Reduce to 0** under the shortage message. Glasses: `REDUCED`, tap. | Can't find it? The coordinator decides in the chat. The picker never guesses. |
| 8 | 72–82 s | A note and a one-tap reply | Reply "Top shelf" to the status message. Glasses show the note; swipe → **Found them**. The reply appears in the group. | Notes reach the glasses. Replies go back in one tap. |
| 9 | 82–90 s | Complete and the final status | Pick the tote bag, tap **Complete**. Glasses: `SAVED · TELEGRAM: SENT`. Status message: `COMPLETED`. | Saved, and the group knows. |
| 10 | 90–110 s | The Mini App console and repository link | Show the order list and timeline; end on the repo URL. | Built on Telegram bots, a Mini App and the Even Hub SDK. github.com/gsoffmarket/stow |

## Rules for the cut

- Keep the real app on screen within the first quarter; name Stow by beat 3.
- No speed-ups. If a cut skips waiting time, say so in a caption.
- The simulator label stays visible throughout. Beat 1 is labelled "illustrative" if it is staged.
- Captions must match what is on screen. Check the film once muted and once audio-only.
- Export 1080p, at most three minutes (target under two).
