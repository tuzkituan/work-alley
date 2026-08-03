import { describe, expect, test } from 'bun:test'
import { groupByStatus, NO_STATUS } from './group-by-status'
import type { ProjectItem } from '@/domain/types'

function item(opts: Partial<ProjectItem>): ProjectItem {
  return {
    id: 'PVTI_1',
    title: 'title',
    status: null,
    assignees: [],
    labels: [],
    contentType: 'issue',
    repository: 'owner/repo',
    number: 1,
    url: null,
    ...opts,
  }
}

describe('groupByStatus', () => {
  test('groups by status, first-seen order', () => {
    const items = [
      item({ id: '1', status: 'In Progress' }),
      item({ id: '2', status: 'Todo' }),
      item({ id: '3', status: 'In Progress' }),
    ]
    const groups = groupByStatus(items)
    expect([...groups.keys()]).toEqual(['In Progress', 'Todo'])
    expect(groups.get('In Progress')?.map((i) => i.id)).toEqual(['1', '3'])
    expect(groups.get('Todo')?.map((i) => i.id)).toEqual(['2'])
  })

  test('buckets missing or blank status under NO_STATUS, last', () => {
    const items = [
      item({ id: '1', status: null }),
      item({ id: '2', status: 'Todo' }),
      item({ id: '3', status: '  ' }),
    ]
    const groups = groupByStatus(items)
    expect([...groups.keys()]).toEqual(['Todo', NO_STATUS])
    expect(groups.get(NO_STATUS)?.map((i) => i.id)).toEqual(['1', '3'])
  })

  test('omits the NO_STATUS bucket entirely when every item has one', () => {
    const groups = groupByStatus([item({ status: 'Done' })])
    expect(groups.has(NO_STATUS)).toBe(false)
  })
})
