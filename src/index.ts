/**
 * User-supplied slug that keys Workers, Worktrees, Claims, Resource leases, and
 * Completions so a second pass reconnects instead of duplicating.
 *
 * Drovr validates the grammar `[a-z][a-z0-9_-]{0,31}` at runtime for every
 * keyed operation and never slugifies invalid values.
 */
export type Name = string

/**
 * Readonly GitHub Issue snapshot returned by {@link Drovr.issues.list}.
 *
 * Fields mirror stable GitHub data at list time. Comments, reactions, milestones,
 * project metadata, and raw `gh` objects are not exposed.
 */
export type Issue = {
  /** Repository in `owner/repo` form. */
  readonly repo: string
  /** GitHub issue number. */
  readonly number: number
  /** Issue title. */
  readonly title: string
  /** Issue body text. */
  readonly body: string
  /** Canonical GitHub issue URL. */
  readonly url: string
  /** GitHub issue state vocabulary. */
  readonly state: 'OPEN' | 'CLOSED'
  /** Label names attached to the issue. */
  readonly labels: readonly string[]
  /** Assignee GitHub logins. */
  readonly assignees: readonly string[]
  /** Author GitHub login, or `null` when absent. */
  readonly author: string | null
  /** ISO-8601 creation timestamp. */
  readonly createdAt: string
  /** ISO-8601 last update timestamp. */
  readonly updatedAt: string
}

/**
 * Named git worktree checkout derived from a {@link Name}.
 *
 * Exposes only Workflow-facing identity and filesystem path.
 */
export type Worktree = {
  /** Validated Name for this Worktree. */
  readonly name: Name
  /** Absolute filesystem path to the Worktree checkout. */
  readonly path: string
}

/**
 * Persistent visible OMP session started for one Worktree.
 *
 * Prompts are sequential; each call waits until the Worker is idle or done.
 */
export type Worker = {
  /**
   * Send one prompt to the Worker and wait for it to finish processing.
   *
   * Overlapping prompts fail. Prompt bodies are not logged by Drovr.
   */
  prompt(text: string): Promise<void>
}

/**
 * Named capacity or port lock leased around scarce work.
 *
 * A Lease is keyed by Resource and {@link Name}. An existing same-Name occupancy
 * reconnects immediately on resume; process crash retains the Lease until the
 * callback returns or throws.
 */
export type Resource = {
  /**
   * Acquire a Lease for `opts.name`, run `fn`, then release the Lease.
   *
   * Returns the value produced by `fn`. A thrown error still releases the Lease.
   */
  lease<T>(opts: { name: Name }, fn: () => Promise<T>): Promise<T>
}

/**
 * Workflow-facing orchestration handle injected by the Drovr CLI.
 *
 * The default export of `.drovr/main.ts` receives this handle. Drovr reruns the
 * Workflow from the top on resume and uses Name as the sole continuity key.
 */
export type Drovr = {
  /**
   * Define a named Resource before leasing.
   *
   * Capacity Resources require an integer capacity of at least one. Port Resources
   * use a separate declaration shape in later runtime versions; re-definition may
   * not reduce capacity below live occupancy.
   */
  resource(name: string, spec: { capacity: number }): Promise<Resource>

  /**
   * Run `fn` for each item with bounded concurrency.
   *
   * Validates every Name from `opts.name`, rejects duplicates, and skips Names
   * already recorded as Completions before invoking callbacks. One failed item
   * does not cancel other active or pending items.
   */
  map<T>(
    items: readonly T[],
    opts: { concurrency: number; name(item: T): Name },
    fn: (item: T) => Promise<void>,
  ): Promise<void>

  /**
   * Acquire or reconnect the Worktree derived from `opts.name`.
   *
   * Fresh creation fails when the derived branch or path already exists. Resume
   * reconnects matching Worktrees in place, including dirty files.
   */
  worktree(opts: { name: Name }): Promise<Worktree>

  /**
   * Start or reconnect a visible Worker in `opts.cwd`.
   *
   * Reconnect requires the live Worker cwd to match `opts.cwd`. Resume waits for
   * an in-flight turn before replaying callback code.
   */
  start(opts: { name: Name; cwd: string }): Promise<Worker>

  /** GitHub Issue listing, Claiming, closing, and releasing. */
  readonly issues: {
    /**
     * List open `ready-for-agent` Issues that are unassigned or already Claimed
     * in this Project database.
     *
     * Defaults to the Start checkout repository; pass `repo` to target another
     * `owner/repo`. Stale Claims for closed Issues are reconciled during listing.
     */
    list(opts?: { repo?: string }): Promise<readonly Issue[]>

    /**
     * Claim `issue` for `opts.name`.
     *
     * Reserves the Issue in the Project database before assigning the authenticated
     * GitHub user while retaining `ready-for-agent`. Same-Name retries reconnect;
     * another Name fails.
     */
    claim(issue: Issue, opts: { name: Name }): Promise<void>

    /**
     * Close a Claimed Issue on GitHub and release its local Claim.
     *
     * Retains assignee and readiness label. Fails when no local Claim exists.
     */
    close(issue: Issue): Promise<void>

    /**
     * Release a local Claim without closing or unassigning the Issue.
     *
     * Fails when no local Claim exists.
     */
    release(issue: Issue): Promise<void>
  }
}
