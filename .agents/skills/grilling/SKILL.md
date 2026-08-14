---
name: grilling
description: Grill the user relentlessly about a plan, decision, or idea. Use when the user wants to stress-test their thinking, or uses any 'grill' trigger phrases.
---

Interview the user relentlessly until you reach a shared understanding. Map this as a **design tree**: every decision branches into the decisions that hang off it.

Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are already settled — the questions you can ask _now_ without guessing at answers you haven't heard yet. Ask the whole frontier in one round: number each question and give your recommended answer. Then wait for the user's answers before the next round.

Grill in plain language. Prefer simple terms over jargon. Be concise, but keep every detail needed for a correct decision — options, constraints, and tradeoffs stay explicit. If a question has multiple choices or answers, format them explicitly as labeled options (`a) <answer>`, `b) <answer>`).

When a round needs technical terms or concepts, define them first in a short block _above_ the questions — one short clause per term, only the terms that round actually uses. Then ask the questions in plain language that can rely on those definitions.

This is the format you should use:

```
**<Term 1>**: <one-clause definition>
**<Term 2>**: <one-clause definition>
**<Term 3>**: ...

❓ **Q1** - **<question title>**: <plain-language question body>
a) <answer>
b) <answer>

➡️ <plain-language recommended answer and rationale>
```

Skip the definitions block when every term in the round is already familiar or settled. Omit labeled options for open-ended questions. Use this pattern for every substantive assistant-authored question, recommendation, explanation, branch summary, and final shared-understanding check. Plain wording must still name a sharp decision surface — never a vague restatement. Use a concrete example or analogy only when a direct phrasing remains abstract. Do not restate every user reply; restate settled decisions plainly in branch summaries and the final shared-understanding check.

Each round the user answers reshapes the tree — settled decisions push the frontier outward and unblock questions that depended on them. Recompute the frontier and ask the next round. A question whose answer depends on another question still open in this round belongs to a _later_ round, not this one.

Finding _facts_ is your job, never the user's. When a frontier question needs a fact from the environment (filesystem, tools, etc.), dispatch a sub-agent to find it — don't ask the user for anything you could look up yourself. Don't block on it: a running exploration is an unsettled prerequisite, so only the questions downstream of it wait for the sub-agent to report — ask the rest of the frontier now. The _decisions_ are the user's — put each to them and wait.

The session is done when the frontier is empty: every branch of the design tree visited, nothing left silently assumed. Do not act on it until the user confirms you have reached a shared understanding.
