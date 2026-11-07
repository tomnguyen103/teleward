#!/usr/bin/env node
import { executeCli } from '../src/cli/teleward.ts';

const code = executeCli(process.argv.slice(2));
process.exit(code);
