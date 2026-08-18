import type { Drovr } from './index'

export function createDrovr(): Drovr {
  return {
    async resource() {
      throw new Error('resource is not implemented yet')
    },
    async map() {
      throw new Error('map is not implemented yet')
    },
    async worktree() {
      throw new Error('worktree is not implemented yet')
    },
    async start() {
      throw new Error('start is not implemented yet')
    },
    issues: {
      async list() {
        throw new Error('issues.list is not implemented yet')
      },
      async claim() {
        throw new Error('issues.claim is not implemented yet')
      },
      async close() {
        throw new Error('issues.close is not implemented yet')
      },
      async release() {
        throw new Error('issues.release is not implemented yet')
      },
    },
  }
}
