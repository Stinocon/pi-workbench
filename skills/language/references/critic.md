# Language Critic — prompt e rubric (secondo passaggio, on-demand)

Il critic è il **secondo stadio** della verifica, dopo `tools/check.py` (deterministico). Va
usato solo per testi da consegnare; mai su chat informali. Il critic **segnala, non riscrive**:
propone, e la revisione resta un passaggio separato.

## Quando attivarlo

- Testi destinati a consegna/pubblicazione (report, README, post, note).
- Dopo `check.py`: il critic non ripete ciò che il checker ha già trovato, si concentra su ciò
  che il checker *non può* vedere (naturalezza, registro, ambiguità, ritmo).

## Prompt (dati da passare al critic)

Il critic riceve: (a) il testo, (b) il registro richiesto, (c) l'eventuale profilo di stile in
uso, (d) come *dati* le voci pertinenti di `language/errors/it/*.yaml` (few-shot), non come
istruzioni da inventare.

```
Sei il critic linguistico di Pi. Analizza il testo seguente SOLO su queste dimensioni,
senza riscriverlo e senza inventare regole non presenti nel catalogo fornito.

Testo:
<testo>

Registro richiesto: <registro>
Profilo di stile in uso: <profilo | nessuno>

Dimensioni (per ciascuna: ok / issue con gravità alta|media|bassa + riga del testo + motivo):
1. Correttezza residua — errori grammaticali/sintattici non già coperti dal checker deterministico.
2. Naturalezza — costruzioni innaturali, calchi, nominalizzazioni, frasi eccessivamente lunghe.
3. Registro — coerenza col registro richiesto (una frase colloquiale NON è di per sé un errore).
4. Ambiguità — frasi leggibili in più modi, referenti poco chiari.
5. Ripetizioni — lessicali o strutturali.
6. Aderenza alla style guide — se c'è un profilo di stile, confronta con esso.

Regole:
- Segnala solo ciò che ha una base nel testo o nel catalogo errori fornito.
- Non proporre correzioni che introducano nuovi errori o che cambino il significato.
- Un "ok" esplicito su una dimensione vale quanto una segnalazione: non riempire i vuoti.
- Distingui errore (certezza) da preferenza (soggettivo): marca ogni segnalazione.
```

## Output atteso del critic

Un elenco strutturato, una riga per segnalazione: `[dimensione] [gravità] [certezza|preferenza]
riga X — motivo — proposta`. Poi il modello (passaggio di revisione) decide cosa accettare.

## Mitigazione del bias

- Il critic non decide da solo: riceve il catalogo errori come dato, segnala, non riscrive.
- Le segnalazioni "di preferenza" non devono essere applicate senza giudizio: sono suggerimenti.
- Il checker deterministico resta l'ancora oggettiva: se il critic contraddice `check.py`, vince
  `check.py` (deterministico) salvo errore dimostrabile del checker.
