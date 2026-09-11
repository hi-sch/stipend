# Stipend

**This is a concept.** It is a synthetic demonstration of a restricted-purpose card product — not a live issuing program, not connected to Lithic, and not for production use. Amounts, agencies, card data, and authorizations are illustrative.

Stipend is a cardholder app and admin console for **envelopes**: incoming social-security and subsidy credits that can only be spent at merchant category codes (and countries) allowed by the paying connection. The UI speaks Lithic shapes (virtual cards, `CONDITIONAL_ACTION` auth rules, book transfers, `PROGRAM_USAGE_RESTRICTION`) and EU payout language (ISO 20022 `pain.001`, EBICS, purpose `SSBE` / `GOVT`).

<p align="center">
    <img src="https://raw.githubusercontent.com/hi-sch/stipend/refs/heads/main/Stipend.png" width="96%" alt="Stipend Screenshot">
</p>


## Run

```bash
npm install
npm run dev
```

The app listens on **http://127.0.0.1:5175**.

## Licence

Copyright 2026, licensed under the [European Union Public Licence v1.2](LICENSE) (EUPL-1.2).
