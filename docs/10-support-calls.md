# "Talk to a person" support calls (9-10 Oct 2026)

Not AI. A customer calls Softoras support by voice from the browser.

## Shaheer's decisions
- Only the **Pro** and **White Label** plans; **free** for the customer.
- **Monday-Friday, 9:00-18:00 Pakistan time** to start (setting).
- For now **all platform admins** can answer; a support team later.
- Browser-to-browser now (Daily.co), **real phone numbers later**.

## How it works
```
Customer: Live Support -> Talk to a person -> Call now
  server checks plan + hours + "one open call per user", creates a PRIVATE
  voice room (Daily.co, max 2 people, no video, closes by itself) and a token
  for the customer only -> "Calling Softoras support..." (ring tone)
Admin panel (any admin page): card "Incoming support call" + ring sound
  (customer, company, plan, page) -> Answer: the FIRST admin wins
  (one database update decides; the others see "Already answered by ...")
Connected: timer, Mute, Hang up / End call. Either side ending closes the room.
Nobody answers in 60 s -> "missed" -> customer can request a callback
(saved in the ERP's existing callback_requests list). Outside hours: callback.
```
Every call is logged: Admin -> Support Calls (customer, company, plan, status,
who answered, length). Settings on the same page (plans, days, hours, ring time,
longest call) - owner / super admin / billing manager.

## Cost
Daily.co: 10,000 free participant-minutes every month (about 500 ten-minute
calls), then about $0.001 per person per minute (voice only).

## Setup
- `DAILY_API_KEY` in the backend environment. Without it: test mode locally
  (no real audio, clearly labelled); calls OFF in production.
- ERP security headers now allow the microphone (ERP pages only) and Daily's
  servers (`*.daily.co`, `*.pluot.blue`); browser library `@daily-co/daily-js` 0.92.2.

## Tests
- 8 automated tests: plan rule, hours, one call per user, two admins answering
  at once (exactly one wins), customer sees "answered", only the answering admin
  can end, missed, cancel, privacy, live admin stream, settings roles.
- Live (local, test mode): Free Trial -> "Pro and White Label only"; closed hours
  -> callback; call -> rings on the admin page -> Answer -> both connected ->
  customer hangs up -> admin card closes, log shows "Ended, 0:13"; callback saved.

## Found while testing
The backend did not allow PUT requests from the browser (CORS), so saving admin
settings (also the Soft AI credit limits, plans and packs from step 9) failed in
the browser. Fixed, with a test.

Real Daily test (9 Oct): the key works and the private room is created, but
joining fails with `account-missing-payment-method`. Daily needs a card on the
account (the free 10,000 minutes still apply). Now, if joining fails, the call
is ended on both sides and the customer gets a clear message and the callback form.

## Monthly limit (12 Oct)
Calls switch off for the rest of the month once this month's usage reaches the limit
(default 9,000 participant-minutes; Daily's free allowance is 10,000; the rest is a buffer for calls
still running). Customers then get the callback form. Setting + usage bar on Admin -> Support Calls
(switch off = no limit). Migration 113; 2 new tests (197 total).
