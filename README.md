# Tokeniser

VS Code-extension som gör användningen av Claude Code synlig och begriplig – bara från dokumenterade, lokala källor.

**Status:** tidigt skede. Alla designbeslut finns i [docs/tokeniser-sammanfattning.md](docs/tokeniser-sammanfattning.md). Den klickbara skissen i [docs/skiss/tokeniser-skiss.html](docs/skiss/tokeniser-skiss.html) ska godkännas innan vyn byggs.

## Utveckling

Kräver Node 24 och VS Code med WSL.

```sh
npm install
npm run build          # bygger dist/extension.js och dist/collector.js med esbuild
npm run watch          # bygger om vid ändring
npm run typecheck
npm test               # enhetstester och tester av den byggda insamlaren
```

Starta extensionen i en utvecklingsinstans med F5 ("Kör extension").

## Insamlaren

Claude Code kör insamlaren som statusrad. Den validerar JSON-datan, skriver en kort rad i terminalen (`5h 64% · v 31% · ktx 21%`) och lägger till en rad i `~/.tokeniser/events/ÅÅÅÅ-MM.jsonl` när mätvärdena har ändrats. Konversationsinnehåll, `session_name`, `transcript_path` och `prompt_id` sparas aldrig.

Tills extensionen har en egen anslutningsknapp finns ett utvecklingsskript. Det visar först en plan och planens hash. `--apply` kräver just den hashen, som binder godkännandet till varje sökväg, rättighet, filhash och diffrad. Ändras något innan planen utförs avbryts körningen utan ändringar.

```sh
npm run connect                                   # visar planen och dess hash, ändrar inget
npm run connect -- --apply=<hash>                 # utför exakt den planen
npm run connect -- --disconnect                   # visar planen för frånkoppling
npm run connect -- --disconnect --apply=<hash>    # återställer settings.json och tar bort insamlaren
```

Skydd i korthet:
- Hela mappkedjan till `~/.tokeniser` och `~/.claude/settings.json` kontrolleras med `lstat`: inga symboliska länkar, rätt ägare, ingen annan kan skriva. Filer öppnas med `O_NOFOLLOW` och kontrolleras sedan på den öppnade filen, inklusive antal hårda länkar.
- `settings.json` skrivs atomärt via en temporär fil och avbryts om innehållet har ändrats sedan planen gjordes.
- Frånkopplingen tar aldrig sökvägar från `connection.json`.
- Insamlaren körs med `env -i` och Nodes behörighetsmodell: den får läsa sin egen fil och läsa och skriva i `events/` och `state/`. Det är skydd på djupet, inte en sandlåda. Behörighetsmodellen stoppar till exempel inte nätverk i Node 24.
- Varje löfte och vad som upprätthåller det står i [docs/insamlarens-sakerhetskontrakt.md](docs/insamlarens-sakerhetskontrakt.md).

## Inläsning

`npm run index` läser nya händelser från `~/.tokeniser/events/` till `~/.tokeniser/index.sqlite` och visar en sammanfattning. JSONL-filerna är sanningskällan. Indexet kan alltid byggas om med `npm run index -- --rebuild`.

- Bara en process i taget läser in, via låsfilen `index.lock`. Varje händelse är unik per fil och byteposition, så inte ens samtidiga läsare utan lås ger dubbletter.
- Läsläget sparas per fil. En halv rad väntar tills den är klar, och en ersatt eller trunkerad fil läses om från början.
- Raderna behandlas som opålitlig data och valideras igen. Text med kontrolltecken sparas inte.
- Projekt identifieras via repot när det finns, annars via mappen. Får en mapp senare en repo-identitet slås historiken ihop.

## I VS Code

Starta en utvecklingsinstans med F5 ("Kör extension"). Extensionen körs inne i WSL och läser `~/.tokeniser`.

- **Statusraden** visar förbrukat, till exempel `5h 64% · v 31%`. Välj läge med `tokeniser.statusBar.mode`: båda gränserna, bara 5 h, bara vecka, närmaste gräns eller kontext. Varningsfärgen börjar vid `tokeniser.statusBar.warningAt` (80) och felfärgen vid `tokeniser.statusBar.errorAt` (95).
- **Datatillstånd:** en klocka visas när senaste värdet är äldre än 5 minuter, `↺` när gränsen har återställts och `–` när värdet saknas. Ett saknat värde visas aldrig som 0.
- **Snabbkortet** visas när musen hålls över statusraden. Det har ringar för gränserna, tid till återställning, kontexten i fönstrets projekt, andra aktiva sessioner, en prognos märkt uppskattning och länken "Öppna Tokeniser".
- **Vyn** ligger i bottenpanelen bredvid Terminal. Klicka på Tokeniser i statusraden för att visa eller dölja den. Den har gränsringar, prognoser, kontextstapel, sessionens tokens, en kurva över 7 dagar, dagens projekt och förslag med kopieringsknapp. Tokens per dag och per session är uppskattningar.
- **Högra sidopanelen:** högerklicka på fliken Tokeniser och välj att flytta den till det sekundära sidofältet. Layouten anpassar sig efter bredden.
- **Förslaget om stor kontext** visas vid `tokeniser.suggestions.contextTokens` (200 000) eller `tokeniser.suggestions.contextPercent` (60), det som kommer först.
- **Hälsa** ligger överst i vyn och är utfälld bara när något är fel. Den visar:
  - senaste data
  - fält som saknas och varför
  - om insamlaren har ändrats
  - om Tokenisers mappar är skyddade
  - om en annan inställning tar över eller stänger av statusraden

  Vid varning får statusraden en ikon, och snabbkortet får en rad med länken "Visa hälsa". Inställningsfiler läses bara för inspektion, och `~/.claude.json` läses aldrig, eftersom den innehåller inloggningen.
- Ett fönster i taget läser in nya händelser till indexet. Övriga fönster läser bara.

F5 kräver att mappen `tokeniser` är öppen som rotmapp i VS Code.

## Struktur

```
src/extension.ts      ingång för VS Code: statusraden och snabbkortet
src/status/           statusradens text, datatillstånd, prognos och snabbkort
src/view/             vyn: data, modell, förslag, säkerhetsregler och webbvyn i src/view/webview/
src/collector/        insamlaren: validering, statusrad och lagring
src/connect/          plan, planhash, diff och återställning för settings.json
src/index/            inläsning till SQLite: validering, projektidentitet, lås och läsläge
src/health/           hälsokontrollen: fakta från filer, inställningar och indexet, och raderna i vyn
src/secure/           kontrollerad filhantering: mappkedja, ägare, rättigheter, atomära skrivningar
scripts/connect.ts    utvecklingsskript för anslutning
scripts/index.ts      utvecklingsskript för inläsning
test/unit/            enhetstester
test/e2e/             tester av byggd insamlare, anslutning och inläsning
test/fixtures/        exempel från dokumentationen och anonymiserad riktig data
docs/                 beslut, skisser och säkerhetskontrakt
```
