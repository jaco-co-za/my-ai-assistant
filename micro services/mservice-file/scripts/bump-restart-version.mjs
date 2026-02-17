#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';

const now = new Date().toISOString();
await writeFile('restart.version', `${now}\n`, 'utf-8');
console.log(`restart.version updated: ${now}`);