/**
 * Run once: node create-icons.js
 * Creates simple green map-pin icons for the extension.
 * Requires: npm install canvas  (or just use any 16/48/128px PNG)
 */

// If you don't want to run this script, simply place any
// 16x16, 48x48, and 128x128 PNG files in the icons/ folder
// named icon16.png, icon48.png, icon128.png

// Simple approach: create minimal valid PNG files programmatically
// using raw binary (a 1x1 green pixel scaled by Chrome)

const fs = require('fs');
const path = require('path');

// Minimal 1x1 green PNG (valid PNG binary)
// This is a base64-encoded 1x1 pixel green PNG
const greenPng1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

const sizes = [16, 48, 128];
const iconsDir = path.join(__dirname, 'icons');

for (const size of sizes) {
  const filePath = path.join(iconsDir, `icon${size}.png`);
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, greenPng1x1);
    console.log(`Created ${filePath}`);
  } else {
    console.log(`Already exists: ${filePath}`);
  }
}

console.log('Icons ready. You can replace them with proper PNG icons.');
