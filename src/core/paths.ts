import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const DEFAULT_PORT = 4680

export function daikoHome(): string {
  return process.env.DAIKO_HOME ?? path.join(os.homedir(), '.daiko')
}

export function dbPath(): string {
  return path.join(daikoHome(), 'daiko.db')
}

export function configPath(): string {
  return path.join(daikoHome(), 'config.json')
}

export interface Config {
  port: number
}

export function ensureHome(): void {
  fs.mkdirSync(daikoHome(), { recursive: true })
}

export function readConfig(): Config {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), 'utf8'))
    return { port: typeof raw.port === 'number' ? raw.port : DEFAULT_PORT }
  } catch {
    return { port: DEFAULT_PORT }
  }
}

export function writeConfig(config: Config): void {
  ensureHome()
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2) + '\n')
}
