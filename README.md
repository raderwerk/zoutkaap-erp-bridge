# zoutkaap-erp-bridge

## Orderdoorgifte

`POST /webhooks/orders` ontvangt een Shopify `orders/create`-payload en stuurt de
order naar `POST /orders` van de ERP-mock. De Shopify-orderreferentie fungeert als
idempotentiesleutel: dubbele en gelijktijdige leveringen maken binnen het draaiende
proces maar één ERP-order; een append-only registratie bewaart dit bovendien over
herstarts heen. Regels, totale korting en verzendkosten worden in
eurocenten doorgegeven.

Stel `ERP_BASE_URL` en `ERP_API_KEY` in voor de lokale ERP-mock. Mislukte ERP-calls
worden maximaal vier keer geprobeerd volgens de ladder van 1, 5, 25 en 125 seconden.
Daarna antwoordt de webhook met een leesbare `502`, wordt incidentinformatie
gestructureerd gelogd en komt de volledige order als JSON-regel terecht in
`data/order-dead-letters.jsonl` (instelbaar met `DEAD_LETTER_PATH`). De succesvolle
idempotentiesleutels staan in `data/order-idempotency.jsonl` (instelbaar met
`IDEMPOTENCY_PATH`).

Middleware tussen de Zoutkaap-webshop (Shopify) en het ERP: voorraadsync elk kwartier, orderdoorgifte met retry en idempotentie, een statuspagina en logging.

## Klant

Zoutkaap is een **fictieve klant** van Raderwerk, gebruikt om de volledige werkwijze van het bureau te bewijzen. Dit is geen mock-up: de code, de CI en de previews zijn echt, alleen de opdrachtgever bestaat niet. Zie `raderwerk/raderwerk-content` en de klantportfolio in `agency-os` voor de volledige merk- en projectcontext.

Deze repository is een backend-service zonder publiek bereikbare pagina's. De voettekstregel "Demonstratiebedrijf van Raderwerk. Dit bedrijf bestaat niet." geldt daarom niet hier, maar wel op `raderwerk/zoutkaap-shop`.

## Stack en waarom

Node.js 22 met TypeScript en Express. Een middleware die af en toe wordt aangeroepen door een cronjob en af en toe door een Shopify-webhook heeft geen framework nodig dat meer doet dan HTTP-routing en JSON. Vitest voor tests (snel, geen aparte configstap voor TypeScript), ESLint met `typescript-eslint` voor statische controle. De orderdoorgifte gebruikt lokale append-only JSONL-bestanden voor idempotentiesleutels en de dode brievenbus.

## Lokaal draaien

Vereist: Node.js 22 of hoger.

```bash
npm install
npm run dev
```

De service luistert standaard op poort 3000 (te overschrijven met de omgevingsvariabele `PORT`).

- `GET /health` — liveness-check, geeft `{ "status": "ok" }`.
- `GET /status` — statuspagina met servicenaam, opstarttijd en (nog te implementeren) sync- en orderstatus.

## Scripts

| Commando | Wat het doet |
|---|---|
| `npm run dev` | Start de service met hot reload |
| `npm run build` | Compileert TypeScript naar `dist/` |
| `npm start` | Start de gecompileerde service uit `dist/` |
| `npm run typecheck` | Controleert types zonder te compileren |
| `npm run lint` | ESLint over de hele repo |
| `npm test` | Voert de testsuite uit met Vitest |

CI (`.github/workflows/ci.yml`, job `ci`) draait typecheck, lint, test en build op elke push en pull request.

## Bijdragen via pull request

Al het werk komt binnen als pull request tegen `main`; niemand merget zijn eigen werk. Zie `AGENTS.md` voor de volledige scope, de Definition of Done en de regels voor agents die hier werken (Codex, Cursor, Claude).

1. Branch vanaf `main`.
2. Voer lokaal `npm run typecheck && npm run lint && npm test && npm run build` uit voordat je een PR opent.
3. Open de PR met het pull request-sjabloon ingevuld.
4. Een mens beoordeelt en merget bij de poort.

## Poorten

Deze repo hangt aan project P1 ("Zoutkaap — Fase 1: shop en ERP verbonden") in de Raderwerk-werkplaats. Merge gebeurt uitsluitend door een mens bij de werkvloer-poort; er is geen automatische merge en geen bypass voor agent-tokens.
