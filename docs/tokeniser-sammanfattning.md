# Tokeniser – sammanfattning av grillningen

**Status:** Designbeslut fattade och gemensam förståelse bekräftad (2026-09-14). Skissen godkänd och insamlaren byggd samma dag, se avsnitt 12.
**Datum:** 2026-09-14
**Miljö vid undersökningen:** Claude Code 2.1.270 (WSL), VS Code 1.137, Node 24.

Det här dokumentet sammanfattar alla beslut från grillningen av projektidén. Det beskriver också vilka tekniska fakta besluten vilar på, vilka risker som finns kvar, vad första versionen ska innehålla och hur den godkänns.

---

## 1. Identitet

Tokeniser är en VS Code-extension som gör användningen av Claude Code synlig och begriplig.

Den skiljer sig från befintliga verktyg genom tre principer:

1. **Bara dokumenterade, lokala källor.** Den gör inga nätverksanrop, läser inga inloggningsuppgifter och anropar inga odokumenterade endpoints.
2. **Tydlig om datans ålder.** Varje siffra visar hur färsk den är, och okända värden visas som okända.
3. **Byggd för WSL och VS Code** från början.

Projektet är både ett personligt verktyg och ett lärprojekt. Poängen är också att bygga det, inte bara att det ska finnas.

## 2. Målgrupp och ambition

| Beslut | Innehåll |
|---|---|
| Målgrupp | Först du själv. På sikt Pro- och Max-användare som kör Claude Code i terminalen. |
| Ambition | Personligt verktyg och lärprojekt. Publicering avgörs senare, efter några veckors egen användning. |
| Kärnvärde | Mätaren är kärnan. Prognos och förslag ingår bara när de går att räkna fram ur datan. |
| Arbetsnamn | "Tokeniser". Mappen byts till `tokeniser`. Slutligt namn bestäms vid en eventuell publicering, och det ska inte börja med "Claude". |

## 3. Begrepp som aldrig blandas ihop

| Begrepp | Nivå | Enhet i Tokeniser |
|---|---|---|
| 5-timmarsgräns | Konto | % förbrukat och tid till återställning |
| Veckogräns | Konto | % förbrukat och tid till återställning |
| Kontextfönster | Session | % av fönstret och antal tokens |
| Tokenanvändning | Session och projekt | Input, output, skapad cache och läst cache |
| Projektanvändning | Projekt | Tokens, sessioner och tid. **Aldrig % av en gräns.** |
| Kostnad | – | Visas inte i första versionen, se Q26 |

- **Förbrukat, inte kvar.** Hela produkten visar förbrukat, precis som Anthropics egna mätare.
- **Märkning.** Uppskattningar märks alltid "uppskattning".

---

## 4. Verifierade fakta som besluten vilar på

### Claude Codes statusrad är den enda dokumenterade maskinläsbara källan
- **Vad den innehåller:**
  - gränserna `rate_limits.five_hour` och `rate_limits.seven_day`, med `used_percentage` och `resets_at`
  - `context_window.*` (fyllnad, fönsterstorlek och tokens) och `exceeds_200k_tokens`
  - `model`, `effort` och `session_id`
  - `workspace.project_dir`, `workspace.repo.*` och `workspace.git_worktree`
  - `prompt_cache.*`, bland annat `last_miss_cause`
  - `cost.*`
- **Villkor för `rate_limits`:**
  - Fältet finns bara för Pro- och Max-abonnenter, och först efter första svaret i sessionen.
  - Varje fönster kan saknas var för sig.
  - Ett fönster tas bort när dess `resets_at` har passerat.
- **När skriptet körs:** vid sessionsstart, vid varje nytt svar, efter `/compact` och när läget för behörigheter ändras. Dessutom när en gräns eller cachen når sin återställningstid, och vid `refreshInterval`.
- **Timing:** uppdateringar samlas med 300 ms fördröjning. Ett skript som fortfarande körs avbryts när nästa uppdatering kommer.
- **`refreshInterval`** kör skriptet igen, men med samma data. **Det finns inget sätt att få en färsk procentsiffra utan ett serveranrop.**
- **Veckogränser per modell saknas** i statusraden, trots att `/usage` visar dem (Anthropics ärende #91920 är öppet).

### Där statusraden inte finns
- **Claude Codes grafiska chattfönster i VS Code** kör ingen statusrad. Önskemålet om det, ärende #55643, stängdes som "not planned".
- **Claude-appen** har en egen mätare för kontext och gränser, men ingen dokumenterad statusrad.
- **Webbsessioner** körs i molnet och lämnar inga lokala spår.
- **Dina egna sessioner:** alla 6 734 svar från Claude i dina lokala sessionsloggar kom från `cli`.

### Gränser och villkor
- **Gemensam gräns.** Anthropics hjälpcenter säger att claude.ai, Claude Desktop och Claude Code räknas mot samma gräns. Procentsiffran i statusraden omfattar alltså även användning i appen.
- **Inget officiellt API** exponerar en abonnents gränser. Admin API gäller bara API-organisationer.
- **Anthropics villkor** förbjuder automatiserad åtkomst, skrapning och att samla in eller lagra inloggningsuppgifter eller sessionstokens. Det gäller Consumer Terms §3.3, §3.4 och §3.7, samt Claude Codes juridiska sida. Därför används inte den odokumenterade endpointen `api/oauth/usage` eller sessionscookies.
- **Befintliga verktyg:** minst 8 extensions visar redan 5-timmars- och veckogränsen, och de flesta gör det via den odokumenterade endpointen med användarens token. Utöver dem finns Claude Codes egen `/usage`, som visar gränser, vad som driver förbrukningen och tips.

### Claude Codes egna loggar och andra källor
- **Sessionsloggarna** (`~/.claude/projects/*/*.jsonl`) innehåller token och modell per meddelande. Men formatet är enligt Anthropic "internt och ändras mellan versioner".
- **Hooks** får ingen användningsdata.
- **OpenTelemetry** ger tokens och kostnad, men inga gränser.

### VS Code
- **Inget flytande kort.** En extension kan inte visa ett flytande HTML-kort ovanpå editorn eller förankrat vid statusraden. Önskemålet #175234 ligger på Backlog.
- **Verktygstipset på statusraden:**
  - Det kan innehålla begränsad HTML, bilder som `data:`-URI och länkar som kör kommandon.
  - Det kan inte innehålla skript eller CSS-animationer.
  - Det öppnas bara när musen hålls över, inte vid klick.
- **Vyer:**
  - En webbvy kan ligga i bottenpanelen, där den kan läggas bredvid Terminal, eller i den högra sidopanelen.
  - Den kan animeras fritt.
  - Den öppnas med kommandot `<viewId>.focus`.
- **Minskad rörelse:** klassen `vscode-reduce-motion` sätts på `body` i webbvyer.
- **Statusradens färger:** bakgrunden kan bara vara `warningBackground` eller `errorBackground`.
- **WSL:** med `extensionKind: ["workspace"]` körs extensionen inne i WSL och läser `~/.claude` och `~/.tokeniser` direkt.
- **SQLite:** `node:sqlite` fungerar både i VS Code på Windows och i VS Code-servern i WSL. Inga moduler behöver kompileras, så ett universellt VSIX-paket räcker.
- **MCP:** VS Code har ett stabilt API för att registrera MCP-servrar, vilket kan användas i en senare version.

---

## 5. Fattade beslut

### Data
| # | Beslut |
|---|---|
| Q6 | **Enda källa i första versionen: Claude Codes statusrad.** Sessionsloggarna kan bli en frivillig reservkälla senare, tydligt märkt "kan sluta fungera". |
| Q7 | **Fyra datatillstånd.** "Realtid" används aldrig i gränssnittet. Nedräkningen till återställning räknas lokalt. |
| Q9 | **Allt sparas per session och projekt från första dagen.** Projekt visas enkelt under detaljer. |
| Q10 | **Gränserna** tas från det senaste värdet i vilken session som helst. **Kontext och modell** tas från den senast uppdaterade sessionen i fönstrets projekt, med den senaste sessionen totalt som reserv. Visas med "+N andra aktiva sessioner". |
| Q12 | **Posten "Utanför VS Code (app, webb, andra enheter)"** är härledd och märkt som uppskattning, se risk R4. Det finns ingen uppdateringsknapp, eftersom inget dokumenterat sätt att hämta färsk data finns. Tokeniser visar "uppdateras vid nästa svar i Claude Code". |
| Q15 | **Projektidentitet:** git-repot (`host/owner/name`) när det finns, annars `workspace.project_dir`. Worktrees räknas till samma projekt, med worktree-namnet som extra etikett. |
| Q16 | **Mätvärden sparas bara när de ändras.** Rådata sparas i 90 dagar, dagssummeringar tills du raderar dem. Det som **inte** sparas beskrivs i avsnitt 7. **Dagssummor av tokens** är en undre gräns, eftersom statusraden bara ger det senaste anropet och uppdateringar inom 300 ms slås ihop. De märks alltid "uppskattning" (beslutat 2026-09-14). |
| Q26 | **Kostnad visas inte för abonnenter** i första versionen. Värdet sparas ändå för eventuell framtida användning. |

**De fyra tillstånden (Q7):**
| Tillstånd | Villkor | Visning |
|---|---|---|
| Aktuell | Senaste värdet är högst 5 min gammalt | Värdet |
| Äldre | Senaste värdet är äldre än 5 min | Värdet och ålder, till exempel "64 % · för 40 min sedan" |
| Återställd | `resets_at` har passerat | "Återställd – ny siffra vid nästa svar", **aldrig 0 %** |
| Saknas | Ingen data, eller fältet saknas | "Saknas" och en konkret orsak |

### Gränssnitt
| # | Beslut |
|---|---|
| Q8 | **Statusraden är valbar**: 5 h och vecka, bara 5 h, bara vecka, närmaste gräns eller kontext. Standard är `5h 64% · v 31%`. Varningsfärg från 80 %, felfärg från 95 %. |
| Q11 | **Innehållet i vyn:** överst två ringar (5 h och vecka) med tid till återställning. Därunder en kontextstapel för sessionen, rutor för input, output, cache och 7 dagar, en kurva över 7 dagar och dagens projekt. Ingen projektbudget. |
| Q13, Q25 | **"Förslag"** med två regler. En knapp kopierar kommandot, inget körs automatiskt. Se reglerna nedan. |
| Q14 | **Prognos för 5 h:** takten räknas på ökningen under de senaste 30 min. Den kräver minst 3 mätningar över minst 10 min och döljs när datan är "Äldre". Texten blir "Når gränsen cirka kl. 15:40" eller "Räcker till återställningen kl. 17:00". **Veckan** räknas likadant på de senaste 24 h. Där måste mätningarna spänna minst 20 h, så att tid utan användning räknas in; annars döljs prognosen med orsak (förtydligat 2026-09-14). Alltid märkt "uppskattning". |
| Q18 | **Placering:** ett snabbkort när musen hålls över statusraden, med en statisk bild, prognos och länken "Öppna Tokeniser". Klick på statusraden visar eller döljer vyn. Vyn ligger i bottenpanelen, bredvid Terminal, med högra sidopanelen som valbar placering. Layouten anpassar sig: bred och låg i bottenpanelen, hög och smal i sidopanelen. |
| Q19 | **Designprocess:** en klickbar skiss görs innan kod, i tre former, båda teman och alla fyra tillstånd. Skisserna från grillningen är bara exempel. |
| Q19 | **Rörelse:** bara när något förändras. Värden glider till sitt nya värde, tillståndsbyten tonar och sektioner fälls ut. Ingen rörelse i vila, inga pulserande "live"-prickar och inga animationer när vyn öppnas. Med minskad rörelse på byts värdena direkt. |

**Regler för Förslag (Q13, Q25):**
1. **Stor kontext:** visas när det som inträffar först av 60 % av fönstret eller 200 000 tokens har passerats. Båda gränserna går att ändra i inställningarna. Förslaget är `/compact`, eller `/clear` om du har bytt uppgift.
2. **Cachemiss med känd orsak:** bygger på `prompt_cache.last_miss_cause`, till exempel att cachen hann gå ut eller att verktyg ändrades.

**Varje förslag visar:**
- vad som observerats
- varför det spelar roll
- rekommenderad åtgärd
- ungefärlig effekt, som bara räknas ut när den går att beräkna (`/clear` ger kontextens storlek, `/compact` visas som "okänd")
- om slutsatsen är säker eller uppskattad

Tonen är saklig och aldrig skuldbeläggande.

### Arkitektur och teknik
| # | Beslut |
|---|---|
| Q17a | **Anslutning:** knappen "Anslut till Claude Code" visar en diff av `~/.claude/settings.json`, sparar en backup och ändrar bara efter bekräftelse. Frånkoppling återställer filen. |
| Q17b | **Terminalen:** skriptet skriver en kort rad i terminalens statusrad, till exempel `5h 64% · v 31% · ktx 42%`. Raden går att stänga av. |
| Q17c | **Insamlaren:** ett Node-skript i `~/.tokeniser/bin/`. Det validerar JSON, lägger till en rad i `~/.tokeniser/events/*.jsonl` och avslutas direkt. |
| Q20 | **Teknik:** TypeScript och esbuild. Vyn byggs i vanlig TypeScript med handgjorda SVG-ringar och kurvor och CSS-övergångar, utan UI-ramverk och grafbibliotek. Styling med `--vscode-*`-variabler. |
| Q21 | **Lagring:** JSONL-filen är sanningskällan. SQLite (`node:sqlite`) är ett index som alltid kan byggas om. Bara ett fönster åt gången läser in nya rader, via en låsfil och ett sparat läsläge. Övriga fönster läser bara. JSONL-filerna roteras varje månad. |
| – | **Körplats:** `extensionKind: ["workspace"]`, så extensionen körs inne i WSL. |

```
Claude Code (terminal i WSL)
   │  statusLine: JSON via stdin
   ▼
~/.tokeniser/bin/collector  ──►  skriver en kort rad i terminalens statusrad
   │  lägger till en rad (validerad)
   ▼
~/.tokeniser/events/YYYY-MM.jsonl     (sanningskälla)
   │  ett fönster läser in (låsfil + läsläge)
   ▼
~/.tokeniser/index.sqlite             (kan byggas om)
   │  läses av alla fönster
   ▼
VS Code-extension: statusrad · snabbkort · vy · hälsokontroll
```

---

## 6. Hotmodell (Q22)

| Risk | Skydd |
|---|---|
| Historiken avslöjar arbetsmönster: projektnamn, sökvägar och tider. | `~/.tokeniser` har rättigheterna 0700 och filerna 0600. Inget innehåll från konversationer sparas. Export är ett aktivt val. |
| Någon byter ut insamlarskriptet, som Claude Code sedan kör. | Skriptet har en fast sökväg och snäva rättigheter. Hälsokontrollen varnar om kontrollsumman har ändrats. |
| En ändring i `settings.json` förstör konfigurationen. | Diff och bekräftelse visas först, backup sparas, och frånkoppling återställer filen byte för byte. |
| HTML-injektion i vyn via repo-, mapp- eller branchnamn. | All text escapas. Strikta säkerhetsregler (CSP) och inga externa resurser. |
| Oavsiktlig nätverkstrafik. | Tokeniser gör noll nätverksanrop, vilket kontrolleras av ett test i CI. |
| Ett repos projektinställningar tar över `statusLine`. | Då finns ingen data i det repot, och hälsokontrollen säger det. Tokeniser visar aldrig felaktiga siffror. |

**Utanför hotmodellen:** processer som körs som din egen användare.
**Framtid:** hotmodellen kan byggas ut, till exempel med signering av skriptet eller en granskning inför publicering.
**Insamlaren:** vad den får ta emot och göra, och vad som upprätthåller varje löfte, står i [insamlarens säkerhetskontrakt](insamlarens-sakerhetskontrakt.md).

## 7. Integritet

- Ingen telemetri, inget konto och ingen molntjänst.
- **Sparas inte:**
  - promptar och kod
  - `session_name`, eftersom den genereras från konversationens innehåll
  - `transcript_path`
- **Du har full kontroll över datan:** den kan visas, exporteras och raderas från vyn.

---

## 8. Första versionen

### Ingår
1. **Klickbar skiss** i tre former, båda teman och alla fyra tillstånd. Den görs först och godkänns av dig innan implementation.
2. **Insamlaren:** validering, en kort rad i terminalen och skrivning till JSONL. Anslutning och frånkoppling med diff och backup.
3. **Inläsning** från JSONL till SQLite, med låsfil, läsläge och rotation.
4. **Statusraden och snabbkortet:** valbar statusrad och snabbkort när musen hålls över.
5. **Vyn** i bottenpanelen, med högra sidopanelen som valbar placering. Den innehåller:
   - gränsringar med tid till återställning
   - de fyra tillstånden
   - kontextstapel och "+N andra"
   - rutor för tokens och cache
   - kurva över 7 dagar
   - dagens projekt
   - posten "Utanför VS Code"
   - prognos
6. **Förslag** med två regler och en knapp som kopierar kommandot.
7. **Hälsokontroll:**
   - senast mottagna data och vilken session den kom från
   - vilka fält som saknas och varför
   - om skriptet har ändrats
   - om ett projekt har tagit över statusraden
8. **Data och inställningar:** export och radering, plus inställningar för statusradsläge, trösklar, placering och terminalrad.
9. **Tillgänglighet:** mörkt och ljust tema, högkontrast och minskad rörelse.
10. **Kvalitet och leverans:**
    - enhetstester mot inspelade JSON-exempel, även trasiga och ofullständiga
    - integrationstest med `@vscode/test-cli`
    - test för noll nätverksanrop
    - CI på GitHub: typkontroll, lint, enhetstester och integrationstest med xvfb
    - lokal VSIX-fil som installeras i WSL

### Ingår inte (senare versioner)
- **Agentgränssnitt:** först `tokeniser status --json`, därefter en skrivskyddad MCP-server.
- **Modellrekommendationer.**
- **Mönsteranalys**, jämförelser mellan arbetssätt och historikvyer längre än 7 dagar. Datan sparas redan.
- **Projektbudget**, en budget du sätter själv och som tydligt skiljs från Anthropics gränser.
- **Kostnadsvisning**, som "motsvarande API-pris".
- **Sessionsloggarna som reservkälla** (frivillig, märkt instabil).
- **Kedjning av en befintlig statusrad**, som krävs för andra användare.
- **Claude Code som körs direkt i Windows**, utanför WSL.
- **Flytande fönster** och **att skriva kommandon i terminalen.**
- **Veckogränser per modell**, om Anthropic lägger till dem i statusraden.
- **Publicering** på Marketplace och Open VSX, och **andra AI-leverantörer.**

---

## 9. Acceptanskriterier för första versionen

1. **Skissen** är godkänd innan implementationen av vyn påbörjas.
2. **Rätt siffror:** statusraden och ringarna visar samma procent som `/usage` vid samma tillfälle, med högst 1 procentenhets skillnad.
3. **Återställning:** den visade tiden stämmer med `resets_at`. Efter `resets_at` visas "Återställd – ny siffra vid nästa svar", aldrig 0 %.
4. **Tillstånd:** data äldre än 5 min visas som "Äldre" med ålder. Utan data visas "Saknas" med konkret orsak. Ett saknat fält visas aldrig som 0.
5. **Rätt session:** kontexten gäller den senaste sessionen i fönstrets projekt. Övriga aktiva sessioner räknas i "+N andra".
6. **Utanför VS Code:** posten är märkt som uppskattning. Den visar "går inte att särskilja" när underlaget inte räcker. Verifieras med inspelade exempel.
7. **Prognos:** den döljs vid färre än 3 mätningar, vid kortare underlag än 10 min och när datan är "Äldre". Den är alltid märkt "uppskattning".
8. **Förslag:** reglerna utlöses korrekt på inspelade exempel, med båda trösklarna. Varje förslag har alla fem delar (observation, varför, åtgärd, effekt, säkerhet). Kommandot kopieras med ett klick.
9. **Insamlaren:** den är klar på under 150 ms i 95 % av körningarna. Trasig eller ofullständig JSON avbryter aldrig Claude Code och skriver aldrig fel i terminalen.
10. **Anslutning:** diff och bekräftelse visas före ändringen, och en backup finns. Frånkoppling återställer `settings.json` byte för byte.
11. **Flera fönster:** två öppna VS Code-fönster ger inga dubbletter i databasen.
12. **Integritet:**
    - noll nätverksanrop, verifierat med test
    - rättigheterna 0700 på mappen och 0600 på filerna
    - `session_name` och `transcript_path` sparas inte
    - radering tar bort all data
13. **Utseende:** mörkt tema, ljust tema och högkontrast är läsbara. Med minskad rörelse på förekommer ingen animation.
14. **Säkerhet i vyn:** ett repo- eller mappnamn med HTML renderas som text.
15. **Prestanda:** extensionen startar på under 200 ms och använder ingen mätbar processor i vila.
16. **Leverans:** CI går igenom, och den lokala VSIX-filen installeras och fungerar i WSL.

---

## 10. Kvarvarande risker

| # | Risk | Hantering |
|---|---|---|
| R1 | Anthropic ändrar eller tar bort `rate_limits` i statusraden, och kärnan i produkten faller. | Datans form valideras. Hälsokontrollen visar vad som saknas. Risken avgör om publicering är klok. |
| R2 | Claude Codes grafiska chattfönster, som Anthropic rekommenderar, kör ingen statusrad. Byter du arbetssätt blir Tokeniser blind. | Accepteras för första versionen. Sessionsloggarna kan bli en frivillig reservkälla senare. |
| R3 | Veckogränser per modell saknas i datan. | Tokeniser visar bara det som finns och förklarar att modellgränser syns i `/usage`. |
| R4 | **"Utanför VS Code" är svårare än det såg ut.** Nya procentsiffror kommer bara i samband med ett *lokalt* svar, och det svaret förbrukar själv av gränsen. Förändringen innehåller alltså alltid lokal användning också, och tokens motsvarar inte procent linjärt (cache och modeller väger olika). | Förslag: kalibrera en lokal takt i "% per 1 000 tokens" från perioder utan extern aktivitet. Det som överstiger förväntan plus en brusmarginal räknas som "utanför", annars visas "går inte att särskilja". **Valideras tidigt med riktig data.** Visar det sig opålitligt stryks posten ur första versionen och ersätts av texten "Gränserna inkluderar Claude-appen". **Hanteringen godkänd 2026-09-14.** |
| R5 | Sessioner i appen och på webben syns bara i den gemensamma procentsiffran, och först vid nästa svar i terminalen. | Kommuniceras tydligt i gränssnittet. |
| R6 | `node:sqlite` är fortfarande experimentell i Node 24. | Den är isolerad bakom indexlagret. JSONL är sanningskällan, så SQLite kan bytas ut. |
| R7 | Statusradens enda kommando krockar med användare som redan har en egen statusrad. | Påverkar inte dig. Kedjning krävs före publicering. |

## 11. Öppna frågor för senare
- Hur modellrekommendationer hålls aktuella när produkten inte får göra nätverksanrop. Troligen regler som följer med extensionsuppdateringar, eller en lokal regelfil du kan redigera.
- Slutligt namn och beslut om publicering.
- Utformning av agentgränssnittet, och exakt vilken data en agent får läsa.

## 12. Nästa steg
1. **Klart 2026-09-14:** mappen heter `tokeniser`.
2. **Klart 2026-09-14:** `git init` och grundstruktur.
3. **Godkänd 2026-09-14:** klickbar skiss i `docs/skiss/tokeniser-skiss.html`. Svar på skissens fyra frågor:
   - förslaget ligger som en fällbar rad överst i vyn
   - 5 h och vecka skiljs åt med färg och etikett, ringarna är lika stora
   - statusraden visar en klocka när datan är "Äldre"
   - bottenpanelen har tre kolumner: gränser, session och historik
4. **Pågår:** insamlaren är byggd och testad 2026-09-14. Den ansluts med `npm run connect`, som visar planen och dess hash, följt av `npm run connect -- --apply=<hash>`. R4 valideras när det finns några dagars riktig data.
5. Implementation enligt avsnitt 8. Varje större del kräver fortfarande ditt godkännande.
   - **Klart 2026-09-14:** repot finns privat på GitHub, så projekt identifieras via `github.com/Lullow/tokeniser`.
   - **Klart 2026-09-14:** inläsningen från JSONL till SQLite (punkt 3), med låsfil, läsläge per fil, omläsning av ersatta filer och sammanslagning när en mapp får en repo-identitet.
   - **Återstår för punkt 3:** dagssummeringar och rensning av rådata efter 90 dagar (Q16).
   - **Klart 2026-09-14:** statusraden och snabbkortet (punkt 4), med alla fem lägen, de fyra datatillstånden, varnings- och felfärg, kontext från fönstrets projekt och prognos märkt uppskattning. Klick på statusraden och länken "Öppna Tokeniser" kommer med vyn.

---

## Källor
- Claude Codes statusrad: https://code.claude.com/docs/en/statusline
- Claude Code i VS Code: https://code.claude.com/docs/en/vs-code
- Claude Code Desktop: https://code.claude.com/docs/en/desktop
- Sessioner och transkript: https://code.claude.com/docs/en/sessions
- Kostnader och `/usage`: https://code.claude.com/docs/en/costs
- OpenTelemetry: https://code.claude.com/docs/en/monitoring-usage
- Juridik och efterlevnad: https://code.claude.com/docs/en/legal-and-compliance
- Hur gränser fungerar: https://support.claude.com/en/articles/11647753-how-do-usage-and-length-limits-work
- Consumer Terms: https://www.anthropic.com/legal/consumer-terms
- Admin API (bara organisationer): https://platform.claude.com/docs/en/manage-claude/usage-cost-api
- Ärenden hos Anthropic: #55643 (statusrad i VS Code-extensionen), #91920 (veckogränser per modell), #78476 (`claude usage --json`)
- VS Code API: https://code.visualstudio.com/api/references/vscode-api
- VS Code webbvyer: https://code.visualstudio.com/api/extension-guides/webview
- VS Code och fjärrmiljöer: https://code.visualstudio.com/api/advanced-topics/remote-extensions
- Hover med webbvy (#175234): https://github.com/microsoft/vscode/issues/175234
- MCP i VS Code: https://code.visualstudio.com/api/extension-guides/ai/mcp
- Node SQLite: https://nodejs.org/api/sqlite.html
