import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { AttachedFolder } from './models.js';

interface RegistryFile {
  folders: AttachedFolder[];
}

/**
 * Which folders on this machine are attached — pure local app config, not
 * provenance data, so it stays out of the relay entirely. The actual edit
 * history lives as real Nostr events; this just maps a filesystem path to
 * the folderId used to tag them.
 */
export class Registry {
  private filePath: string;
  private data: RegistryFile;

  constructor(overrideDir?: string) {
    const dir = overrideDir ?? path.join(os.homedir(), '.tracer');
    fs.mkdirSync(dir, { recursive: true });
    this.filePath = path.join(dir, 'registry.json');
    this.data = fs.existsSync(this.filePath)
      ? (JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as RegistryFile)
      : { folders: [] };
  }

  listFolders(): AttachedFolder[] {
    return this.data.folders;
  }

  findFolderByPath(folderPath: string): AttachedFolder | undefined {
    return this.data.folders.find((f) => f.path === folderPath);
  }

  findFolderById(id: string): AttachedFolder | undefined {
    return this.data.folders.find((f) => f.id === id);
  }

  insertFolder(folder: AttachedFolder): void {
    if (this.data.folders.some((f) => f.id === folder.id)) return;
    this.data.folders.push(folder);
    this.save();
  }

  private save(): void {
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
  }
}
