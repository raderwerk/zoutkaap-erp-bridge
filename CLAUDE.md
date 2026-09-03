# CLAUDE.md

Zie `AGENTS.md` voor de volledige scope, Definition of Done en PR-conventies van deze repository.

Kort samengevat, ook voor Claude:

- Scope: alleen de middleware (voorraadsync, orderdoorgifte, statuspagina, logging) tussen Zoutkaap en het ERP.
- Voer vóór elke pull request `npm run typecheck && npm run lint && npm test && npm run build` uit.
- Nooit mergen, nooit force-pushen, nooit deployen, nooit geheimen committen.
- Werk altijd via een pull request tegen `main`; een mens merget bij de poort.
- Onderteken de PR-beschrijving of samenvattende comment met de rol, bijvoorbeeld `— Uitvoerder: Claude`.
