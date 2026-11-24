import type { Comment } from './types.ts'

export type MarkerName = 'intake' | 'spec' | 'decision' | 'approval' | 'docs' | `round-${number}`

export const MARKER_LINE = /^<!--\s*factory:[^>]*-->\s*$/

export const marker = (name: MarkerName): string => `<!-- factory:${name} -->`

export const withMarker = (name: MarkerName, body: string): string => `${marker(name)}\n${body}`

export const ROUND_MARKER = /^<!-- factory:round-([1-9][0-9]*) -->\s*$/

export const firstLine = (body: string): string => body.split(/\r\n|\r|\n/, 1)[0] ?? ''

export const isMarkerComment = (c: Comment): boolean => MARKER_LINE.test(firstLine(c.body))

export const findMarked = (comments: Comment[], name: MarkerName, author: string): Comment | undefined =>
  comments.find((c) => c.author === author && firstLine(c.body) === marker(name))

export const stripMarker = (body: string): string =>
  MARKER_LINE.test(firstLine(body)) ? body.split(/\r\n|\r|\n/).slice(1).join('\n') : body
