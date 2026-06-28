import { mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentLabPersona, AgentLabStoredPair } from './types';

export interface StoredPersonaRecord {
  persona: AgentLabPersona;
  pairs: AgentLabStoredPair[];
}

export class AgentLabStore {
  constructor(private readonly root: string) {
    mkdirSync(root, { recursive: true });
  }

  listPersonas(): AgentLabPersona[] {
    const out: AgentLabPersona[] = [];
    for (const file of this.safeFiles()) {
      const record = this.readRecord(file);
      if (record) out.push(record.persona);
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getPersona(personaId: string): StoredPersonaRecord | null {
    return this.readRecord(`${personaId}.json`);
  }

  savePersona(record: StoredPersonaRecord): void {
    mkdirSync(this.root, { recursive: true });
    writeFileSync(
      join(this.root, `${record.persona.id}.json`),
      JSON.stringify(record, null, 2),
      'utf-8',
    );
  }

  deletePersona(personaId: string): boolean {
    try {
      rmSync(join(this.root, `${personaId}.json`), { force: true });
      return true;
    } catch {
      return false;
    }
  }

  private safeFiles(): string[] {
    try {
      return readdirSync(this.root).filter((file) => file.endsWith('.json'));
    } catch {
      return [];
    }
  }

  private readRecord(file: string): StoredPersonaRecord | null {
    try {
      return JSON.parse(readFileSync(join(this.root, file), 'utf-8')) as StoredPersonaRecord;
    } catch {
      return null;
    }
  }
}
