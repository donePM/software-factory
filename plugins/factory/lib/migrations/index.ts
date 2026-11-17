export type Migration = {
  from: number
  name: string
  // biome-ignore lint: old config shapes are unknown by definition
  up(old: any): any
}

export const migrations: Migration[] = []
