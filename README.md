# Tokeniser

VS Code-extension som gör användningen av Claude Code synlig och begriplig – bara från dokumenterade, lokala källor.

**Status:** tidigt skede. Alla designbeslut finns i [docs/tokeniser-sammanfattning.md](docs/tokeniser-sammanfattning.md). Den klickbara skissen i [docs/skiss/tokeniser-skiss.html](docs/skiss/tokeniser-skiss.html) ska godkännas innan vyn byggs.

## Utveckling

Kräver Node 24 och VS Code med WSL.

```sh
npm install
npm run build      # bygger dist/extension.js med esbuild
npm run watch      # bygger om vid ändring
npm run typecheck
```

Starta extensionen i en utvecklingsinstans med F5 ("Kör extension").

## Struktur

```
src/extension.ts   ingång för VS Code
docs/              beslut och skisser
```
