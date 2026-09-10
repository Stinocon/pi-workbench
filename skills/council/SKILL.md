---
name: council
description: Convene an adversarial council of five deliberately partial perspectives (contrarian, first-principles, expansionist, outsider, operator) with blind peer review and a synthesis, for ONE high-stakes judgement call under uncertainty. NOT the default mode — not for calculations, facts, retrieval or mechanical work, which have a right answer and are executed or verified, not deliberated.
summary: /council — adversarial council for high-stakes judgement
---

# Council — adversarial deliberation for high-stakes judgement under uncertainty

## When to use

Use `/council` for **one decision of judgement under uncertainty** where there is no verifiable
answer — strategic choices, architecture forks, product-design tension with foundational
constraints, a call where three plausible readings each point somewhere different and you cannot
compute the answer.

**Not the default mode.** Do NOT convene the council for:

- calculations, conversions, densities — those are computed or verified, not deliberated;
- facts, lookups, retrieval — those are found and cited;
- mechanical work — that is executed;
- a question where a direct question to the user closes it — if a crisp question settles the
  matter, it beats the council.

Convening the council is itself a cost and a ceremony. Use it only when deliberating genuinely
changes the outcome and no tool or question resolves it.

## The five perspectives

Convene **five deliberately partial** perspectives. Each is partial on purpose — the value is in
the tension, not in a balanced average. Feed each the same full context (the decision, the
constraints, what is known and what is unknown).

1. **Contrarian** — attacks the obvious answer, the framing itself, and the premise. What looks
   safe and where is it actually exposed? What is everyone assuming that is false?

2. **First principles** — strips the problem to fundamentals and rebuilds from the actual goal,
   not from precedent, convention or "how we've always done it".

3. **Expansionist** — looks for the option nobody listed. What is being artificially narrowed?
   What adjacent capability, lever or interpretation is untapped? Push the boundary of the
   solution space before settling.

4. **Outsider** — takes the perspective of someone who walks in with no context and no loyalty to
   the project's received wisdom. What looks confusing, fragile or unjustified to a fresh reader?
   What would they pick and why?

5. **Operator** — the execution reality: the person who actually runs it day to day, with the
   constraints of effort, cost, maintenance and real data. Is it buildable, keepable and honest
   in practice — not just in the plan?

## Blind peer review

Each perspective produces a **position: verdict + reasoning + the single strongest objection to
its own position**. Then each perspective (anonymised, id) reviews the other four positions and
raises the best counterargument against each. Keep each reviewer blind to who the others are —
what matters is the argument, not authority.

## Synthesis

After positions and blind cross-reviews, produce a **synthesis**:

1. Where the five agree and disagree, and why the disagreement exists (different value placed on
  different risks, not a factual error).
2. The strongest objection to each leading option.
3. The recommended option, with the trade-off stated explicitly and the conditions under which
   it would be wrong.
4. What is genuinely undeterminable and what single cheap action would most reduce that
   uncertainty (a probe, a prototype, a question to the user).

The synthesis is a recommendation, not a verdict handed down. Surface cons and risks before
pros; state the conditions under which the recommendation would be false.

## Method and boundaries

- **One decision per council.** Do not let it sprawl into a review of the whole project.
- **Evidence over speculation.** Each position cites what is known and labels what is assumed.
  Keep the four registers distinct: verified fact, inference, assumption, undeterminable. A
  plausible-but-unverified claim does not become fact because it was argued confidently.
- **Falsify, don't confirm.** Every perspective actively looks for the conditions under which
  the leading option is false.
- **Strong opinions, loosely held.** Positions are firm; the council outcome is open until the
  synthesis.
- **A direct question to the user beats the council.** If the crux is a missing fact or a
  user preference, ask first.
- Convergence: if all five agree immediately and the answer was deliberate, the question was
  probably not a council question. Say so.

## Output

Run the council as five subagents (use the `subagent` tool in a five-task parallel batch, one
per perspective), then blind peer-review in a second parallel batch, then produce the synthesis
yourself against the combined output. Present:

- the decision under deliberation
- each perspective's position + strongest self-objection
- the cross-reviews
- the synthesis and recommendation

Keep it tight. The deliverable is the recommendation and the conditions under which it would be
wrong — not a wall of deliberation transcript.