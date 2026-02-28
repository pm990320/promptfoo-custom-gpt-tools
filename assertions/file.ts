import fs from 'node:fs';
import path from 'node:path';
import mime from 'mime-types';
import type { AssertionResult, FileAssertOptions } from '../src/types';

function fail(reason: string): AssertionResult {
  return { pass: false, score: 0, reason };
}

export function fileAssert(filePath: string, options: FileAssertOptions = {}): AssertionResult {
  const expectExists = options.exists ?? true;
  const exists = fs.existsSync(filePath);

  if (expectExists && !exists) return fail(`Expected file to exist: ${filePath}`);
  if (!expectExists && exists) return fail(`Expected file not to exist: ${filePath}`);
  if (!exists) return { pass: true, score: 1 };

  const stats = fs.statSync(filePath);

  if (typeof options.minSize === 'number' && stats.size < options.minSize) {
    return fail(`Expected file size >= ${options.minSize} bytes, got ${stats.size}`);
  }

  if (typeof options.maxSize === 'number' && stats.size > options.maxSize) {
    return fail(`Expected file size <= ${options.maxSize} bytes, got ${stats.size}`);
  }

  if (options.extension) {
    const expected = Array.isArray(options.extension) ? options.extension : [options.extension];
    const ext = path.extname(filePath);
    if (!expected.includes(ext)) {
      return fail(`Expected extension ${expected.join(', ')}, got ${ext || '(none)'}`);
    }
  }

  if (options.mimeType) {
    const expected = Array.isArray(options.mimeType) ? options.mimeType : [options.mimeType];
    const detected = mime.lookup(filePath);
    if (!detected || !expected.includes(detected)) {
      return fail(`Expected MIME type ${expected.join(', ')}, got ${detected || 'unknown'}`);
    }
  }

  return { pass: true, score: 1 };
}
