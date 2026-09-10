---
name: language
description: "Language Intelligence Layer for Pi — deterministic, data-driven rules for grammatical correctness, natural syntax, lexical register and LLM-typical error avoidance in Italian (extensible to other languages). Use BEFORE drafting and to CHECK generated text: load the relevant rules by register, then run tools/check.py and the critic pass. This is the CORRECTNESS layer; a separate style layer may choose among the constructions this layer deems correct."
summary: "Language correctness layer (grammar, register, errors, deterministic checker)"
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
├── rules/it/                   # regole interrogabili (YAML, per lingua)
│   ├── grammar.yaml            # concordanza, consecutio, congiuntivo, ipotetico, ...
│   ├── punctuation.yaml        # virgole, punto e virgola, maiuscole, apostrofi
│   ├── register.yaml           # registri + lessico + anglicismi (con provenienza)
│   └── llm-tells.yaml          # errori tipici LLM (calchi, nominalizzazioni, ...)
├── errors/it/                  # catalogo errori (wrong/right/rule/severità)
│   ├── grammar-errors.yaml
│   └── llm-errors.yaml
├── corpus/it/examples.yaml     # V2: esempi annotati
└── tools/
    ├── check.py                # critic deterministico (stdlib, zero dipendenze)
    └── test_check.py           # un test per regola
```

## Regola d'uso

1. **Caricamento selettivo, mai tutto.** Prima di scrivere, leggi solo i file pertinenti al
   registro richiesto (es. `grammar.yaml` + `register.yaml` per un testo formale). Non riversare
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
2. Caricamento selettivo regole         → read rules/it/{grammar,punctuation,register,llm-tells}.yaml
                                           (solo sezioni pertinenti al registro)
3. Generazione bozza                    → cloud primary
4. check.py (se attivato)               → deterministico: issue meccaniche
5. Critic LLM (se attivato)             → rilettura con rubric + few-shot da errors/
6. Revisione                            → cloud primary applica le correzioni accettate
7. Output
```

I passi 4-5 sono **opt-in**: si attivano per testi da consegnare, non per chat informali.

## Comandi

```bash
L=~/.pi/agent/skills/language/tools/check.py

# verifica deterministica (JSON: span, rule_id, severity, suggestion, confidence)
python3 $L check "Se lo sapevo, venivo."

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
aderenza alla style guide. Il critic riceve come *dati* le voci pertinenti di `errors/`
(few-shot) e segnala; non riscrive senza motivo e non inventa regole non presenti.

## Estensione ad altre lingue

I file sono per-locale (`rules/it/`, `rules/en/`, ...). Una nuova lingua = nuovi file YAML
nello stesso schema + regole in `check.py`. Nessuna modifica all'architettura.

## Provenienza

Regole ed esempi grammaticali fondati su **grammatica-italiana.dossier.net** (guida di Fausto
Carapucci, che cita Palazzi, Serianni, Mortara Garavelli, Marchese-Sartori, Regula-Jernej) e
sulla grammatica italiana standard. Ogni voce YAML riporta il `source` puntuale.
