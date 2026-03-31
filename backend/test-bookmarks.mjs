import { extractSectionsFromBookmarks } from './bookmarks.js';

const pdfPath = "C:\\manuals\\22071_A3_VESDA-E_VEP-A10-P_Product_Guide_A4_IE_lores.pdf";
const filename = "22071_A3_VESDA-E_VEP-A10-P_Product_Guide_A4_IE_lores.pdf";

const sections = await extractSectionsFromBookmarks(pdfPath, filename);

console.log('\nDetected sections:');
if (sections.length === 0) {
  console.log('  No sections found!');
} else {
  sections.forEach(s => console.log(`  ${s.name} → page ${s.page}`));
}