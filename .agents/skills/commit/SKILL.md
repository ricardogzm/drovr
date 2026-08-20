---
name: commit
description: Commit under the Package Release contract. Use when creating, amending, or squashing a commit, or when the working tree mixes unrelated changes.
---

# Commit

Create one coherent commit that satisfies the Package Release contract.

## Process

### 1. Inspect

Read the intended diff, the originating issue or spec if one exists, and the rest of the working tree. Name the single coherent change this commit represents. Stage those paths by name. Unrelated user files stay unstaged.

If the work is several concerns, split them and run this skill once per commit. If it cannot be one concern, stop and say so.

**Done when:** the index holds exactly that change, or this skill stops because nothing coherent is ready.

### 2. Select

Pick one type. Write a subject-only message in the form `type(scope): subject`. Add a scope only when it names something the subject does not. When the work comes from a known issue, put `#N` in the subject.

**User-visible.** The text after the type and scope prefix is the Package Release bullet:

- `feat`: new capability → Added
- `fix`: correction → Fixed
- `perf`: performance → Changed
- `refactor`: compatible behavior change → Changed
- `remove`: deleted behavior or surface → Removed

Mark a breaking change with `!` after the type or scope (`feat!:`, `feat(scope)!:`) or a `BREAKING CHANGE` footer. A breaking subject is the Breaking Changes bullet, including a breaking `remove`.

**Hidden.** Name the work in history with `docs`, `test`, `build`, `ci`, or `chore`.

When the subject cannot carry the why, add one or two sentences of why, not how.

**Done when:** the message uses one type that matches the staged change, and stripping the prefix leaves the release bullet (or a hidden history subject).

### 3. Commit

Create the commit, or amend or squash when the user asked, or when `HEAD` is this agent's own unpushed commit for the same change. Stop after the local commit.

**Done when:** `HEAD` is that commit.

### 4. Report

Show the commit SHA, the subject, and any paths left unstaged.

**Done when:** the SHA, subject, and leftover unstaged paths are shown.
