export type Migration = {
  from: number
  name: string
  // any: an old config shape has no type. Each migration checks the fields it reads.
  up(old: any): any
}

export const migrations: Migration[] = []
