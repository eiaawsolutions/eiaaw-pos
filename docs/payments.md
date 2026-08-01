# Payments — what settles how, and what to turn on

The POS is meant to sell before anyone has signed up for anything. Cash and
manually-keyed cards need no gateway and never did; the electronic rails need
one, and refuse themselves clearly until it exists.

## Three ways to run

| Mode | Configure | Takes |
|---|---|---|
| **No gateway** (default) | nothing | Cash, and cards run on the merchant's own bank terminal with the approval code keyed in |
| **Billplz** | `BILLPLZ_API_KEY`, `BILLPLZ_X_SIGNATURE`, `BILLPLZ_COLLECTION_ID`, `PUBLIC_API_URL` | The above, plus DuitNow QR, FPX, Touch 'n Go, GrabPay, Boost, ShopeePay — confirmed automatically by callback |
| **Demo** | `PAYMENTS_ENABLE_MOCK=true` | Fakes a QR rail that captures after five seconds. Refuses to start in production. |

Nothing else changes between them. The tender buttons on the terminal are the
same; an unconfigured rail answers with the variables to set rather than
failing obscurely.

## Why Billplz

EIAAW already holds the account. The same three keys are in Infisical and wired
in the Social Media AI Team app, and the All-in-one business suite locked the
same decision independently — see EIAAW-ORG
`docs/runbooks/reuse-existing-subscriptions.md`, whose whole finding is that
launching should cost zero new subscriptions.

One Billplz contract covers every rail the terminal offers. **Stripe does not
substitute**: its Malaysian support is FPX and GrabPay, GrabPay is online-only,
and DuitNow QR, Touch 'n Go and Boost are absent from its payment-method
matrix entirely. Stripe Terminal *does* cover card-present in Malaysia, which
is a genuine option for automating the card path — a separate adapter, not yet
written.

## What Billplz actually does at the counter

A hosted bill, not a native merchant QR. The POS opens a bill, gets a URL back,
and the terminal renders that URL as the QR on the customer display. The
customer scans it, picks their rail on Billplz's page, pays, and the callback
tells the POS it settled.

That is one tap more than pointing a banking app at a static DuitNow code, and
it is the trade for not holding a PayNet acquiring contract directly. If that
tap matters commercially, the alternative is a direct acquirer — which is a new
contract, and the thing this arrangement avoids.

## Two things that will surprise anyone extending this

**Billplz signs a reconstruction, not the bytes.** Every other gateway HMACs the
raw request body — that is what `verifyWebhook(headers, rawBody)` is shaped for,
and re-serialising before hashing is a bug this codebase has already fixed once.
Billplz instead sorts the callback's fields, renders each as key-immediately-
followed-by-value, joins them with pipes, HMACs *that*, and sends the result as
an `x_signature` field **inside the body**. The body is form-encoded, not JSON.
Parsing before verifying is safe there only because the scheme is defined over
the parsed fields. Do not copy that reasoning to a raw-body gateway.

**Billplz sends no per-delivery id.** The sink needs one to tell a replay from a
retry, so the adapter derives it from what makes a delivery distinct: the bill,
the state being reported, and the paid-at stamp. A genuine retry reduces to the
same string and is dropped; a later state change on the same bill does not.

## Refunds

Billplz has no refund API on v3 — refunds are raised by a human in their
dashboard. The adapter throws and says so rather than returning success, because
a refund on the books that never left the merchant's account is worse than an
error. Refund in the dashboard, then void or refund the order here.

## Turning it on

1. Put the three Billplz values in the environment (they exist in Infisical
   already; the Collection ID is per-merchant and comes from the Billplz
   dashboard).
2. Set `PUBLIC_API_URL` to something Billplz can reach. On a laptop that means a
   tunnel — without it bills are created and never confirmed.
3. Leave `BILLPLZ_SANDBOX=true` until a real ringgit has moved in staging.
4. Restart. The boot log prints the routing: which rails are live and via what.

## Still open

- **Stripe Terminal adapter** for card-present, if automating the card path is
  wanted. Stripe is already owned; only the adapter is missing.
- **Settlement reconciliation.** `/payments/reconciliation` totals our own
  ledger. It does not yet pull the gateway's settlement report and compare, so
  a discrepancy between what the PSP says it paid out and what the POS recorded
  taking is still found by hand.
