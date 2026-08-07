// Team board rules.
//
// This decides whether a task may be called done, so it lives here as a plain
// function rather than inside a panel's render body — it is a rule worth
// testing, and a render body is not a place a test can stand.
import type { TeamTask } from '@shared/types'

/**
 * Review roles that still owe a passing verdict on `task`.
 *
 * Empty means nothing blocks it. Only the latest verdict per role counts, so a
 * re-review supersedes an earlier one — a role that failed and then passed is
 * satisfied, and one that passed and was then re-reviewed as failing is not.
 * Role names are matched case-insensitively, because gates are configured by
 * hand and reviews are labelled by the agent.
 */
export function pendingGates(task: TeamTask, reviewGates: string[]): string[] {
  if (task.status === 'done' || task.requiresReview === false) return []
  return reviewGates.filter((role) => {
    const forRole = task.reviews.filter((r) => r.role.toLowerCase() === role.toLowerCase())
    const latest = forRole[forRole.length - 1]
    return !latest || latest.verdict !== 'pass'
  })
}
