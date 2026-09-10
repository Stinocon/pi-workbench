---
name: crawl
description: Web scraping and data collection with crawl4ai — turns web pages into clean LLM-ready Markdown for RAG, agents and data pipelines. Use when you need to fetch/scrape web content into Markdown or structured data. NOT for SEO/technical site audits (use site-audit). Local-only by default, no Docker; an explicit egress gate is mandatory before any outbound crawl.
summary: web scraping & data collection (crawl4ai; egress gate, polite crawl)
---

# Crawl — scraping e raccolta dati con crawl4ai

## Quando usarlo

Quando devi **acquisire contenuti web** per un pipeline: scraping di pagine → Markdown pulito →
RAG / dataset / elaborazione LLM. Il motore di riferimento è **crawl4ai** (libreria Python
async, Apache-2.0, ~79k stelle, la più usata del settore).

**Non è** l'audit tecnico SEO (report di title/meta/link/issue): per quello usa la skill
`site-audit` (LibreCrawl). crawl4ai ti dà la *materia prima* — Markdown, metadata, link, status
code — non il report.

## Installazione (no Docker)

Nel venv del progetto (Python ≥3.10):

```bash
pip install crawl4ai        # pinna la versione (vedi Provenienza)
crawl4ai-setup              # installa i browser Playwright (solo se serve rendering JS)
```

Il rendering JS è opzionale: per pagine statiche basta `light_mode`. I browser Playwright
(~300MB) servono solo per SPA / infinite-scroll.

## Pattern consolidati

### 1. Gate di egress — SEMPRE

Ogni crawl va in rete ed espone l'IP pubblico. Prima di partire: flag esplicito + conferma
umana + VPN (es. `CY_ALLOW_WEB_EGRESS=1`). Il gate è programmatico, non a fiducia:

```python
val = (os.getenv("ALLOW_WEB_EGRESS") or "").strip().lower()
if val not in ("1", "true", "yes", "on"):
    raise RuntimeError("web egress disabled: set ALLOW_WEB_EGRESS=1 (VPN + conferma) before crawling")
```

### 2. Crawling educato

Sempre: `check_robots_txt=True`, `mean_delay` (ritardo medio tra richieste) e
`semaphore_count` (concorrenza massima). Mai esplodere un sito a piena banda.

### 3. Isolamento della versione

L'API di crawl4ai cambia tra release. Filtra i kwargs a quelli accettati dalla versione
installata e importa il deep-crawl in modo difensivo:

```python
def _supported_kwargs(cls, kwargs):
    params = set(inspect.signature(cls).parameters)
    return {k: v for k, v in kwargs.items() if k in params and v is not None}

try:
    from crawl4ai.deep_crawling import BFSDeepCrawlStrategy
    from crawl4ai.deep_crawling.filters import DomainFilter, FilterChain, URLPatternFilter
    have_deep = True
except Exception:
    have_deep = False
```

### 4. Deep crawl delimitato

Sempre delimitare dominio, profondità e pagine: `DomainFilter(allowed_domains=[...])` +
`max_depth` + `max_pages`. Mai un crawl senza tetto.

### 5. Fallback Wayback per i siti che bloccano i bot

Se il sito è dietro Cloudflare/WAF, archive.org è il fallback legittimo (CDX API pubblica,
suffisso `id_/` per il contenuto originale). Resta un'uscita di rete → soggetta al gate.

### 6. Gestione del risultato

`result.markdown.raw_markdown` (o `result.markdown` se stringa); skippa `success=False`;
deduplica per URL; scarta contenuti sotto `word_count_threshold`.

## Esempio minimo

```python
import asyncio
from crawl4ai import AsyncWebCrawler, BrowserConfig, CrawlerRunConfig

async def main():
    async with AsyncWebCrawler(config=BrowserConfig(headless=True, light_mode=True)) as crawler:
        result = await crawler.arun(
            url="https://example.com",
            config=CrawlerRunConfig(check_robots_txt=True, mean_delay=1.0, semaphore_count=2),
        )
        if result.success:
            print(result.markdown.raw_markdown)

asyncio.run(main())
```

## Vincoli di sicurezza (non derogabili)

1. **Solo libreria/CLI in locale.** Il server Docker/FastAPI di crawl4ai ha avuto vuln critiche
   (RCE, SSRF, JWT hardcoded) corrette in 0.8.7/0.9.0 → mai esporlo.
2. **Cloud API (beta) off-limits**: manda i dati sul loro cloud → vietata per dati privati
   (coerente con local-first).
3. **Playwright esegue JS dei siti scansionati** → il rendering JS è una trust boundary; per
   siti non fidati preferisci `light_mode`.
4. **Pinna la versione** e registra la provenienza (AGENTS.md §6).

## Contratto

- **produce:** Markdown pulito + metadata da pagine web
- **consuma:** URL seed da cui partire

## Provenienza

- **crawl4ai** (unclecode/crawl4ai), Apache-2.0. Prima di aggiornare, leggi le release note
di sicurezza 0.8.7 / 0.9.0.
- Pattern consolidati da un pipeline di crawling interno già verificato — nessuna copia da terzi.
