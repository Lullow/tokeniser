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

Tills extensionen har en egen anslutningsknapp finns ett utvecklingsskript:

```sh
npm run connect                          # visar ändringen i ~/.claude/settings.json, ändrar inget
npm run connect -- --apply               # installerar insamlaren, sparar backup och skriver ändringen
npm run connect -- --disconnect          # visar vad frånkopplingen gör
npm run connect -- --disconnect --apply  # återställer settings.json
```

## Struktur

```
src/extension.ts      ingång för VS Code
src/collector/        insamlaren: validering, statusrad och lagring
src/connect/          plan, diff och återställning för settings.json
scripts/connect.ts    utvecklingsskript för anslutning
test/unit/            enhetstester mot exempel på statusradsdata
test/e2e/             tester av den byggda insamlaren
docs/                 beslut och skisser
```
