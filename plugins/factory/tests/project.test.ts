import { expect, test } from 'claude-code/testing'
import { STATUS } from '../lib/labels.ts'
import { FACTORY_OPTIONS, optionFor } from '../lib/project.ts'

test('optionFor maps each state to one Factory option', () => {
  expect(FACTORY_OPTIONS).toEqual(['Backlog', 'Intake', 'Spec', 'Design', 'Build', 'Review', 'Waiting', 'Ready to merge', 'Docs', 'Done', 'Rejected'])
  expect(optionFor(null)).toBe('Backlog')
  expect(Object.fromEntries(STATUS.map(s => [s, optionFor(s)]))).toEqual({
    intake: 'Intake', 'needs-info': 'Waiting', fastlane: 'Build', spec: 'Spec', 'needs-design': 'Design', build: 'Build',
    review: 'Review', 'needs-human': 'Waiting', approved: 'Ready to merge', docs: 'Docs', done: 'Done', rejected: 'Rejected',
  })
})
