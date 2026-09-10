---
name: clean-marks
description: Detect and remove invisible/bidi Unicode characters (zero-width, bidi controls, homoglyph spaces, variation selectors, tag chars, noncharacters, private-use) from text files — hygiene and trojan-source defense on content you own. Use when a paste looks broken, an identifier misbehaves, a diff shows nothing but the code changed, or before committing/publishing text. Text-only, deterministic, zero dependencies, local-only. Does NOT do statistical-watermark rewriting or metadata stripping (out of scope by design).
summary: strip invisible/bidi Unicode chars (Layer A; engine vendored MIT)
---

# Clean marks — igiene dei caratteri invisibili (Layer A)

Rimuove i **caratteri Unicode invisibili/bidi** dai file di testo: zero-width (U+200B/C/D, U+2060,
U+FEFF), controlli bidi (U+202A-202E, U+2066-2069), spazi omografi (U+00A0, U+3000, …), variation
selector, tag chars, noncharacters, private-use. Sono i vettori del **trojan-source** (bidi) e dei
"paste rotti" (zero-width) — bug invisibili che non si vedono nel diff né nel codice sorgente.

**Preserva il testo legittimo**: ZWJ/emoji (❤️‍🔥), joiners di script (arabo, indic), bandiere
(tag chars), coppie bidi valide, filler/selector contestuali (mongolo, khmer, hangul). Rimuove
solo il "contrabbando".

## Comandi

```bash
R=~/.pi/agent/skills/clean-marks/scripts/clean_marks.py

# report sola-lettura (cosa c'è, dove, con quale confidenza)
python3 $R inspect <file>

# come inspect ma exit 2 se trova qualcosa (per hook/CI/gate)
python3 $R check <file>

# pulisci: default scrive <file>.cleaned ; --in-place fa backup .bak
python3 $R clean <file>
python3 $R clean <file> --in-place

# opzioni
python3 $R clean <file> --nfkc --aggressive --strip-bidi --strip-emoji-glue
```

## Regole d'uso

1. **`inspect` prima di `clean`** — vedi cosa stai per rimuovere; alcuni caratteri sono legittimi
   (bidi in testo RTL, ZWJ nelle emoji) e il tool li preserva già, ma leggi il report.
2. **Mai `--in-place` senza review** sul primo giro: il default scrive `.cleaned`, non sovrascrive.
3. **Trojan-source**: se `check` segnala `bidi` (U+202A-202E) in codice, è quasi certamente
   malevolo — non "pulirlo", capire da dove è arrivato (allinea a `check-injection.sh`).
4. **Testo solo**: niente binari/PDF/immagini (il tool li rifiuta). Metadata (C2PA/EXIF) e
   watermark statistici sono **fuori scope di proposito** (dual-use).

## Provenienza

Motore (`scripts/text_unicode.py`, `scripts/common.py`) **vendored verbatim** da
`guillaumemeyer/watermarks-remover` (MIT), commit `d775dbe`, auditato e pinnato — dettagli e
licenza completa in `NOTICE.md`. Il wrapper `clean_marks.py` e questo SKILL.md sono nostri.
È stato distillato **solo** il livello A (igiene); livello B (rewrite statistico anti-detection)
e metadata stripping lasciati fuori: il primo è dual-use, il secondo richiede tool esterni.
