---
name: commit
description: Commit with the Package Release Conventional Commit contract. Use when preparing, creating, amending, or squashing a commit; selecting a user-visible feature, compatible fix, compatible changed or removed behavior, breaking change, or hidden maintenance message; or when the working tree mixes unrelated or multi-concern changes.
---

# Commit

Create one coherent commit that satisfies the Package Release contract.

## Process

### 1. Inspect

Read the intended diff, the originating issue or spec if one exists, and the rest of the working tree. Name the single coherent change this commit represents. Stage those paths by name. Unrelated user files stay unstaged.

If the work is several concerns, split them and run this skill once per commit. If it cannot be one concern, stop and say so.

**Done when:** the index holds exactly that change, or this skill stops because nothing coherent is ready.

### 2. Select

Read the live contract, then encode one message from it:

1. A repository commit-message validator in `package.json` scripts, a repo bin, or `.husky`.
2. Otherwise GitHub issue #37 via `gh issue view 37`.

Write a subject-only message. For a user-visible change, the text after the type and scope prefix is the Package Release bullet. For hidden maintenance, pick a hidden type from the contract and name the work in history. Add a scope only when it names something the subject does not. Mark a breaking change with the contract's breaking marker. When the work comes from a known issue, put `#N` in the subject.

When the subject cannot carry the why, add one or two sentences of why, not how.

**Done when:** the message matches the staged change, a single contract branch, and a subject that remains the bullet after the prefix is stripped.

### 3. Validate

When a repository validator exists, run it on the message. When the contract is #37, check the message against that issue body. Rewrite from the diagnostic until it accepts.

**Done when:** the validator or #37 accepts the message.

### 4. Commit

Create the commit, or amend or squash when the user asked, or when `HEAD` is this agent's own unpushed commit for the same change. Stop after the local commit.

**Done when:** `HEAD` is that commit.

### 5. Report

Show the commit SHA, the subject, and any paths left unstaged.

**Done when:** the SHA, subject, and leftover unstaged paths are shown.