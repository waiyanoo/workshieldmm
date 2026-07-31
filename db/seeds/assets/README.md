# Payment method assets

## `mmqr-dragon-innovation.png`

The merchant QR buyers scan to pay for credits and subscriptions. Cropped from
the MyanmarPay poster to the QR card plus the merchant name — the name is kept
deliberately, because reading "DRAGON INNOVATION" under the code is the only
check a payer has that they are paying the right business before the money
moves.

Decoded payload (EMVCo / MMQR, CRC verified):

| Field | Value |
| --- | --- |
| Payload format (`00`) | `01` |
| Point of initiation (`01`) | `11` — **static**, carries no amount |
| Merchant account (`26`) | `com.mmqrpay.www`, acquirer `223733820116158`, merchant `30116938` |
| Merchant category (`52`) | `5977` |
| Currency (`53`) | `104` (MMK) |
| Country (`58`) | `MM` |
| Merchant name (`59`) | `DRAGON INNOVATION` |
| City (`60`) | `Yangon` |

Two things follow from that payload and are worth knowing before changing
anything here:

- **It is static.** No amount is encoded, so the payer types the amount
  themselves. That is what the reconciliation flow already assumes — we show
  the amount and a reference code, they pay and hand back their wallet's
  transaction number, and an admin confirms it against the statement. A dynamic
  (per-transaction) QR would let us drop the manual match, and would be worth
  asking AYA about if volume grows.
- **MMQR is the Central Bank's unified standard,** so this one code is scannable
  by KBZPay, AYA Pay, Wave Pay, CB Pay and the rest. It replaces the per-wallet
  QR the provider list was originally built around; the older per-wallet
  providers remain in the enum only because settled payments reference them.

`52 = 5977` is "cosmetic stores" — how the merchant is registered with the
acquirer, not something this codebase sets. It does not affect payments, but if
a bank ever applies category rules it is the field to point at.

## Provisioning a new environment

Nothing loads this automatically. Upload it through the admin endpoint, which
puts it in object storage and writes the audit entry:

```bash
curl -X POST http://localhost:4000/admin/payment-methods \
  -H "Authorization: Bearer $SUPER_ADMIN_TOKEN" \
  -F provider=mmqr \
  -F "displayName=MMQR (MyanmarPay)" \
  -F "accountName=DRAGON INNOVATION" \
  -F accountNumber=30116938 \
  -F active=true \
  -F "qr=@db/seeds/assets/mmqr-dragon-innovation.png"
```

Replacing the QR later is the same call. Never edit `payment_methods` directly:
the endpoint is what records who changed where customer money goes.
