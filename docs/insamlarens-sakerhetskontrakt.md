# Insamlarens säkerhetskontrakt

**Antaget:** 2026-09-14
**Gäller för:** insamlaren `~/.tokeniser/bin/collector.cjs`, installerad med `npm run connect` från commit `b86880b` eller senare.

Claude Code kör insamlaren automatiskt varje gång statusraden uppdateras, i alla sessioner och med dina rättigheter. Kontraktet säger exakt vad insamlaren får ta emot, vad den får lämna ifrån sig och vad som upprätthåller varje löfte. Ett löfte räknas bara om det har ett test.

---

## 1. Hotmodell

**Skyddar mot:**
- andra användare på datorn
- en insamlare som har byggts fel eller ändrats, till exempel via ett förgiftat bygge
- symboliska och hårda länkar i Tokenisers mappar
- trasig eller skadlig data från Claude Code eller från ett repos inställningar

**Skyddar inte mot:** kod som redan körs som din användare. Sådan kod kan ändra insamlaren, `settings.json` och Node-filen direkt.

## 2. Indata

| Källa | Tillåtet |
|---|---|
| stdin | JSON från Claude Code. Allt som inte klarar valideringen avvisas eller märks som ogiltigt. |
| Argument | `--home=<absolut sökväg>` och `--no-line`. Båda är fasta i `settings.json`. |
| Klockan | Mottagningstid och om en gräns har återställts. |

**Inte tillåtet:** miljövariabler, filer utanför `events/` och `state/`, nätverk.

## 3. Utdata

- **stdout:** en rad på formen `5h <värde> · v <värde> · ktx <värde>`. Varje värde är ett heltal med `%`, `↺` eller `–`. Ingen text från indata hamnar på raden.
- **stderr:** aldrig något.
- **Avslutskod:** alltid 0.
- **Filer:**
  - `events/ÅÅÅÅ-MM.jsonl`: tillägg
  - `state/<session_id>.last`: ersätts atomärt
  - `state/problems.jsonl`: tillägg med bara orsak och tid

**Aldrig:** `bin/`, `backup/`, `connection.json`, `settings.json` eller något utanför `~/.tokeniser`.

## 4. Förbjudet

- nätverk
- subprocesser, trådar och inbyggda tillägg
- dynamisk kod: `eval`, `new Function` och `import()`
- att skapa mappar

## 5. Data som sparas

- **Sparas:** bara fälten i vitlistan i `src/collector/record.ts`.
- **Sparas aldrig:** `session_name`, `transcript_path`, `prompt_id` eller något innehåll från konversationen.

## 6. Beteende vid fel

| Situation | Beteende |
|---|---|
| Trasig eller ogiltig indata | Ingen rad, inget i stderr, orsaken sparas i `problems.jsonl`. |
| Saknad eller osäker lagring | Raden skrivs ändå, men ingenting sparas. |
| stdin stängs aldrig | Avslutas med kod 0 efter 2 sekunder. |

---

## 7. Hur löftena upprätthålls

**Skyddsnivåer:**
- **Utanför Node:** upprätthålls av kommandot i `settings.json` innan Node startar. En ändrad insamlare kan inte ta sig förbi det.
- **Behörighetsmodellen:** Nodes `--permission`, utöver vår kod. Det är skydd på djupet, inte en sandlåda. Node beskriver själv modellen som ett skyddsbälte för betrodd kod och inte som en gräns mot skadlig kod.
- **Kod:** vår kod och testerna. En ändrad insamlare kan bryta löftet.

| # | Löfte | Skyddsnivå | Test |
|---|---|---|---|
| 1 | Läser inga miljövariabler | Utanför Node (`env -i`) och kod | `behörighetsmodellen stoppar en ändrad insamlare från det viktigaste (skydd på djupet)`, `bundlen använder bara tillåtna Node-moduler, ingen miljö och ingen dynamisk kod`, `insamlaren körs med tom miljö och snäva rättigheter` |
| 2 | Tar bara emot `--home` med absolut sökväg och `--no-line` | Kod | `osäker eller saknad lagring stoppar aldrig statusraden`, `--no-line sparar men skriver ingen rad` |
| 3 | Skriver bara i `events/` och `state/` | Behörighetsmodellen och kod | `behörighetsmodellen stoppar en ändrad insamlare från det viktigaste (skydd på djupet)`, `symlänkad events-mapp avvisas och målet lämnas orört` |
| 4 | Skriver aldrig genom en hård länk | Kod | `hårt länkad månadsfil avvisas och målet lämnas orört`, `tillägg genom en hård länk avvisas och målet lämnas orört` |
| 5 | Läser bara sin egen fil, `events/` och `state/` | Behörighetsmodellen | `behörighetsmodellen stoppar en ändrad insamlare från det viktigaste (skydd på djupet)` |
| 6 | Skapar inga mappar | Kod, och behörighetsmodellen utanför `events/` och `state/` | `insamlaren skapar inga mappar själv` |
| 7 | Inga subprocesser, trådar eller inbyggda tillägg | Behörighetsmodellen och kod | `behörighetsmodellen stoppar en ändrad insamlare från det viktigaste (skydd på djupet)`, `bundlen använder bara tillåtna Node-moduler, ingen miljö och ingen dynamisk kod` |
| 8 | Ingen dynamisk kod | Kod | `bundlen använder bara tillåtna Node-moduler, ingen miljö och ingen dynamisk kod` |
| 9 | Stdout innehåller bara etiketter och siffror | Kod | `terminalraden innehåller bara fasta etiketter och siffror` |
| 10 | Inget i stderr och alltid avslutskod 0 | Kod | `trasig JSON avbryter aldrig och skriver inget i terminalen`, `osäker eller saknad lagring stoppar aldrig statusraden`, `stänger stdin aldrig: avslutas efter spärren med kod 0 och utan utdata` |
| 11 | **Inget nätverk** | **Kod** | `bundlen använder bara tillåtna Node-moduler, ingen miljö och ingen dynamisk kod` |
| 12 | Sparar aldrig innehåll från konversationen | Kod | `sparar aldrig sessionsnamn, transkript, prompt-id eller annat utanför listan`, `sparar inget innehåll från konversationen` |
| 13 | Filer har 0600 och mappar 0700 | Kod, kontrolleras vid anslutning | `mappar får 0700 och filer 0600`, `anslut och koppla från: rätt rättigheter, fungerande kommando och byte för byte tillbaka` |

Testerna finns i `test/unit/` och `test/e2e/` och körs med `npm test`.

## 8. Kända luckor

1. **Nätverk stoppas inte utanför vår kod.** I Node 24.14 nådde ett anslutningsförsök nätverket trots `--permission` (`ECONNREFUSED`). Två vägar ska utredas: `unshare -rn`, som kräver att användarnamnrymder är tillåtna, och `--allow-net` i nyare Node-versioner, som inte är verifierat.
2. **Insamlaren kan inte kontrollera mappkedjan till `~/.tokeniser` själv.** Behörighetsmodellen nekar insamlaren `lstat` ovanför `events/` och `state/`. Anslutningen kontrollerar kedjan, och hälsokontrollen i extensionen gör om kontrollen vid varje uppdatering. Den upptäcker en ändring men hindrar inte insamlaren från att skriva under tiden.
3. **Hårda länkar hanteras av koden, inte av körmiljön.** Behörighetsmodellen jämför bara sökvägar.
4. **stdin läses i sin helhet** innan storleksgränsen på 1 MiB kontrolleras.
5. **Fritext rensas inte från kontrolltecken** innan den sparas. Terminalraden påverkas inte, men vyn och framtida kommandon måste escapa texten.
6. **`problems.jsonl` och `state/` växer utan gräns.**
7. **Node-filen kan ändras av din användare.** Dess hash kontrolleras bara när planen görs.

## 9. Anslutningsskriptet

För anslutningsskriptet är planen kontraktet, en körning i taget. `npm run connect` visar varje sökväg, rättighet, filhash och diffrad, och `--apply=<hash>` utför bara exakt den planen. Frånkopplingen tar aldrig sökvägar från `connection.json`.

## 10. Så ändras kontraktet

1. Dokumentet och testerna ändras i samma commit.
2. Varje ändring av insamlaren eller dess rättigheter ändrar planens hash. En installerad insamlare byts bara ut genom frånkoppling och ny anslutning.
3. Ett löfte utan test i tabellen räknas inte som upprätthållet.
