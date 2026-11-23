// Reads a committed PNG's size for the tests that check icons and link-preview images.
const { expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Read a PNG's width and height from its IHDR chunk, which always comes first.
 *
 * @param {string} file the PNG's path from the repository root
 * @returns {{width: number, height: number}} in pixels
 */
function readPngSize(file) {
  const bytes = fs.readFileSync(path.join(ROOT, file));
  expect(bytes.subarray(0, 8).equals(PNG_SIGNATURE), file + ' is a PNG').toBe(true);
  expect(bytes.toString('latin1', 12, 16), file + ' starts with IHDR').toBe('IHDR');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

module.exports = { readPngSize };
