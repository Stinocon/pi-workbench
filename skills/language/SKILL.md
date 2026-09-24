---
name: language
description: "Language Intelligence Layer for Pi — deterministic, data-driven rules for grammatical correctness, natural syntax, lexical register and LLM-typical error avoidance, in Italian and English. Use BEFORE drafting and to CHECK generated text: load the relevant rules by language and register, then run tools/check.py (--lang it|en|all) and the critic pass. This is the CORRECTNESS layer; a separate style layer may choose among the constructions this layer deems correct."
summary: "Language correctness layer (grammar, register, errors, deterministic checker; it + en)"
---

# Language — Language Intelligence Layer

Questa skill codifica **come funziona correttamente la lingua** — non come scrive una persona
specifica. Uno strato di **stile** separato può scegliere *tra* le costruzioni corrette e
naturali quella più adatta al registro; non introduce mai errori grammaticali deliberatamente,
salvo richiesta esplicita.

## Struttura

```
language/
├── SKILL.md                    # questo file: orchestrazione + pipeline
├── rules/<lingua>/             # regole interrogabili (YAML, una cartella per lingua)
│   ├── grammar.yaml            # concordanza, consecutio, congiuntivo, ipotetico, ...
│   ├── punctuation.yaml        # virgole, punto e virgola, maiuscole, apostrofi
│   ├── register.yaml           # registri + lessico + anglicismi (con provenienza)
│   └── llm-tells.yaml          # errori tipici LLM (calchi, nominalizzazioni, ...)
├── errors/<lingua>/            # catalogo errori (wrong/right/rule/severità)
│   ├── grammar-errors.yaml
│   └── llm-errors.yaml
└── tools/
    ├── check.py                # critic deterministico (stdlib, zero dipendenze)
    ├── test_check.py           # un test per regola
    └── check_rule_refs.py      # ogni `check:` nel YAML esiste davvero in check.py
```

Lingue presenti: **`it`** e **`en`**. `corpus/it/examples.yaml` era elencato qui come V2 e non
esiste: è stato tolto, perché una struttura che promette un file assente è un documento che mente.

## Regola d'uso

1. **Caricamento selettivo, mai tutto.** Prima di scrivere, leggi solo i file pertinenti alla
   lingua e al registro richiesti (es. `rules/en/grammar.yaml` + `rules/en/register.yaml` per una
   nota tecnica in inglese formale). Non riversare
   tutti i file nel contesto: sono dati, si caricano per categoria.
2. **Il modello tratta le parole, il codice tratta le strutture.** Le regole meccaniche
   (apostrofi, concordanze rilevabili con pattern, errori catalogati) sono verificate da
   `check.py` in modo deterministico; il modello non deve "ricordarsi" di non sbagliarle.
3. **`check.py` segnala, non corregge.** Restituisce `{span, rule_id, severity, suggestion,
   confidence}`; decide il modello se e come correggere. Mai auto-correzione.
4. **Registro ≠ correttezza.** Una frase colloquiale può essere perfettamente corretta. Il
   registro è una scelta di lessico/sintassi, non un giudizio di correttezza.
5. **Provenienza obbligatoria.** Ogni regola/voce ha un campo `source`. Nessuna voce senza fonte.

## Pipeline di generazione

```
1. Intento + lingua + registro          → ragionamento (cloud primary)
2. Caricamento selettivo regole         → read rules/<lingua>/{grammar,punctuation,register,llm-tells}.yaml
                                           (solo sezioni pertinenti al registro)
3. Generazione bozza                    → cloud primary
4. check.py (se attivato)               → deterministico: issue meccaniche
5. Critic LLM (se attivato)             → rilettura con rubric + few-shot da errors/<lingua>/
6. Revisione                            → cloud primary applica le correzioni accettate
7. Output
```

I passi 4-5 sono **opt-in**: si attivano per testi da consegnare, non per chat informali.

## Comandi

```bash
L=~/.pi/agent/skills/language/tools/check.py

# verifica deterministica (JSON: span, rule_id, severity, suggestion, confidence)
python3 $L check "Se lo sapevo, venivo."

# solo le regole di una lingua (it|en|all; default all: entrambi i set sono ad alta precisione)
python3 $L check "Your a good engineer." --lang en

# verifica con testo da stdin
echo "Il risultato è apposto" | python3 $L check -

# lista delle regole attive
python3 $L rules

# test del motore (una regola senza test non è valida)
python3 $L test
```

## Critic LLM (secondo passaggio, on-demand)

Dopo `check.py`, per i testi da consegnare si fa un passaggio di rilettura col critic. Rubric:
correttezza residua, naturalezza, registro, ambiguità, ripetizioni, costruzioni innaturali,
aderenza alla style guide. Il critic riceve come *dati* le voci pertinenti di `errors/<lingua>/`
(few-shot) e segnala; non riscrive senza motivo e non inventa regole non presenti.

## Estensione ad altre lingue

I file sono per-locale (`rules/it/`, `rules/en/`, ...). L'inglese è stato aggiunto esattamente così:
quattro file YAML + il catalogo errori con lo stesso schema, più i pattern in `check.py` — ognuno con
il suo caso positivo, il suo caso negativo e la sua guardia di precisione in `test_check.py`. Una
nuova lingua = gli stessi passi, nessuna modifica all'architettura.

**La precisione viene prima della copertura.** Una regola che segnala una frase corretta insegna a
ignorare il checker: gli esempi ambigui restano guida per il modello nel YAML e non vengono
meccanizzati. Per l'inglese, `robust` e `comprehensive` hanno un senso tecnico reale e non sono nel
pattern del lessico da marketing; `unlock`, `empower` ed `elevate` restano nella guida, dove il
modello vede il contesto, invece che in una regex che non lo vede.

## Provenienza

Regole ed esempi grammaticali fondati su **grammatica-italiana.dossier.net** (guida di Fausto
Carapucci, che cita Palazzi, Serianni, Mortara Garavelli, Marchese-Sartori, Regula-Jernej) e
sulla grammatica italiana standard. Ogni voce YAML riporta il `source` puntuale.

Le regole inglesi fondano su referenze standard dichiarate per nome — *Merriam-Webster's Dictionary
of English Usage*, *The Chicago Manual of Style* — **senza numeri di sezione**: non sono stati
verificati su un'edizione a stampa, e una citazione inventata è peggio di nessuna citazione. Le voci
del catalogo `llm-tells` / `llm-errors` sono una distillazione interna e lo dichiarano come `source`,
invece di attribuirsi un'autorità che non hanno.
