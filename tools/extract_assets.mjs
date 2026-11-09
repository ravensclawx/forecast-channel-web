// Extracts the decrypted channel contents the site needs (main.dol, HOME Menu sounds, system font, earth, weather)
// from a WAD + common key into assets/content_<n>.bin, so the site runs without them.
//   node tools/extract_assets.mjs <HAFE.wad> <common-key.bin>
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { ESTitle } from '../js/rvl/ES.js';
const [wadPath, keyPath] = process.argv.slice(2);
const t = new ESTitle(new Uint8Array(await readFile(wadPath)), new Uint8Array(await readFile(keyPath)));
await mkdir(new URL('../assets/', import.meta.url), { recursive: true });
for (const i of [1, 6, 7, 8, 9]) {
  const c = t.content(i);
  await writeFile(new URL(`../assets/content_${i}.bin`, import.meta.url), c);
  console.log(`content ${i}: ${c.length} bytes`);
}
