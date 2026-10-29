# Soft AI - Step 5: Chat panel inside the ERP

The visible part: a ChatGPT-style chat inside Softoras ERP, replacing the Shaka placeholder.
Code lives in the ERP copy (`repo/current/Softoras-ERP-main`, git branch `soft-ai`),
folder `src/features/soft-ai/` - see its README for file-by-file details.

## What the user gets

- **Round button (bottom right) on every page** -> side panel. Hidden on `/soft-ai` and
  when `NEXT_PUBLIC_SOFT_AI_API_URL` is not set.
- **`/soft-ai`** -> the same chat, full page (with "open full page" from the panel).
- **Chat list** (left): new chat, pinned first, rename / pin / delete (with confirmation).
- **Credits button** (bottom of the list): balance; popover with "Buy credits" (goes to
  Billing; real purchase is step 9).
- **Messages**: streamed replies, Markdown shown safely, "Thinking…", Stop, "Stopped",
  error line ("you were not charged"). Urdu / Arabic flow right-to-left automatically.
- **No credits**: clear message + "Buy credits"; the typed text is given back.

## Changes to Shaheer's existing files (3, all small)

| File | Change | Why |
|---|---|---|
| `dashboard-layout.tsx` | load `SoftAiLauncher` instead of `ShakaAssistant` | replace the button |
| `app/(dashboard)/soft-ai/page.tsx` | render `SoftAiFullPage` | full-page view |
| `lib/security/headers.ts` | CSP `connect-src` adds the configured Supabase + Soft AI origins | **Found in testing:** his Content-Security-Policy only allowed `*.supabase.co`, so the browser would have blocked every call to Soft AI on the live site. Now exactly the two configured services are allowed, nothing else. |

Everything else is new files in `src/features/soft-ai/`. Old Shaka files are unused (Shaheer can delete).

## Safety

- Requests carry the user's Supabase login token and the organization id; the backend
  checks both every time (step 2). No passwords, no cookies.
- Replies are never inserted as HTML: a small Markdown reader turns them into data, React
  builds the elements. HTML in a reply stays text; `javascript:` / `data:` links are not clickable.

## Testing (7 Oct 2026, local only)

Ran Shaheer's ERP (`npm run dev`) against the LOCAL Supabase (`.env.local`, git-ignored) and our
backend with real Gemini. Test account created through his normal sign-up page (credentials in
`local-dev/test-accounts.local.md`, local only).

| Checked in the browser | Result |
|---|---|
| Soft AI button replaces Shaka, opens side panel | OK |
| Send question -> streamed answer, numbered list + bold shown correctly | OK |
| New chat named from first question, appears at top of list | OK |
| Credits go down after each answer (24.95 -> 24.92 -> 24.89 ...) | OK |
| Urdu question -> Urdu answer, right-to-left | OK |
| Open saved chat from list (history loads) | OK |
| Rename, pin (moves to top with pin icon), delete with confirmation | OK |
| Full page `/soft-ai` | OK |
| Zero credits -> "No credits left" + Buy credits, text given back, Gemini not called | OK |
| Credits popover (balance, Buy credits) | OK |
| Stop button | Could not catch live: Gemini finished 700-word answers in 2-4 s before the click landed. Covered by the automated backend test (partial reply saved, partial charge). |

Automated: 10 panel logic tests (streaming reader, safe Markdown, dangerous links), ERP
TypeScript check 0 errors, ERP ESLint clean on all touched files; backend 97 tests unchanged.

## Problems found and fixed during testing

1. **CSP would block Soft AI on the live site** (see table above) - fixed in `headers.ts`.
2. **Empty "New chat" left in the list** when the first message was refused (no credits) -
   the empty chat is now deleted (and the list reload waits for it).
3. **No-credits message hard to read** in some themes - now uses the ERP theme colours.
4. Credits shown as "24.7" -> always 2 decimals ("24.70"); tiny amounts keep 4.
5. Divider lines (`***`) shown as stars -> now drawn as a line.
6. React lint rules (ref updated during render, state set in effect) -> rewritten the
   recommended way.

## Known / for later

- Shaheer's page instructions for `/soft-ai` (his `module-instructions` config) say "look up
  live ERP data" - not true until steps 6-7. His file; mention to him or update at step 7.
- His `Permissions-Policy` header blocks the microphone (`microphone=()`): voice input
  (optional, later) will need that changed.
- Urdu uses the browser's default Arabic-script font, not Nastaliq. A Nastaliq font can be
  added if Shaheer wants.
