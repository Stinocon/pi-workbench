# Language benchmark — rubric e procedura di confronto

Misura se la Language Layer (ed eventualmente uno strato di stile) migliora *davvero* il
modello. L'obiettivo non è la configurazione più sofisticata, ma **quale complessità produce
miglioramento misurabile**.

## Configurazioni a confronto

| Config | Composizione |
|--------|--------------|
| A | modello base |
| B | modello + profilo di stile |
| C | modello + Language Layer |
| D | modello + Language Layer + profilo di stile |
| E | D + critic (check.py + critic LLM) |

## Metrica 1 — Correttezza (deterministica, oggettiva)

`benchmark/score.py` esegue `tools/check.py` sull'output di ogni caso e produce un punteggio
pesato per gravità (high=3, medium=2, low=1). **Più basso = meglio**; 0 = senza errori
deterministici. È l'ancora oggettiva: non dipende da un giudice LLM.

```
python3 benchmark/score.py --outputs out-A.json
# → {"config":"A","cases":25,"total_issues":N,"score":X}
```

## Metrica 2 — Naturalezza e stile (giudice LLM, blind)

Per le dimensioni non deterministiche, il cloud primary valuta in **blind** (senza sapere la
configurazione), con rubric fissa, più giudizi per item e media. Dimensioni (1-5):

1. **Naturalezza** — assenza di costruzioni artificiali, calchi, nominalizzazioni, ripetizioni.
2. **Aderenza allo stile** — "legge come una relazione/nota nel registro target?" (solo B, D, E).
3. **Coerenza del registro** — registro richiesto mantenuto per tutto il testo.

**Mitigazione del bias LLM-as-judge**: rubric fissa, valutazione blind, più giudizi per item,
e le metriche deterministiche (`check.py`) come àncora indipendente. Un giudizio di stile non
prevale mai su un errore deterministico misurato da `check.py`.

## Metrica 3 — Costo

- **Latenza**: wall-time per configurazione (media su N run).
- **Risorse**: token consumati + numero di tool invocation (check.py, critic).

## Procedura

1. Far girare le 5 configurazioni sui 25 casi di `cases.yaml` (stesso modello, stessa temperatura).
2. Raccogliere gli output in `out-{A..E}.json` (formato di `score.py`).
3. Correttezza: `score.py` per ciascuna → tabella.
4. Naturalezza/stile/registro: giudice blind → tabella.
5. Latenza/risorse → tabella.

## Interpretazione (criteri decisionali)

- Se **D ≈ C** → lo strato di stile non aggiunge correttezza (è solo stile, come previsto).
- Se **E ≈ D** → il critic non si paga: va reso opzionale o tolto.
- Se **C ≈ A** → la Language Layer non migliora la correttezza: rivedere regole/checker.
- Il target è **D** (language + stile) con correzione alta e stile preservato; **E** solo se il
  delta di qualità giustifica latenza e chiamate extra.

Un componente aggiuntivo si *giustifica* solo se il benchmark mostra un delta misurabile, non
perché è "più sofisticato".
