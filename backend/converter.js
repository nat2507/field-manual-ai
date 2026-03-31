import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

// Find Ghostscript executable on Windows
function getGhostscriptPath() {
  return 'C:\\PROGRA~1\\gs\\GS1006~1.0\\bin\\gswin64c.exe';
}

// Convert specific pages of a PDF to base64 images
export async function pdfPagesToImages(pdfPath, pageNumbers) {
  const gsPath = getGhostscriptPath();
  const tmpDir = "C:\\tmp_images";

// Create temp folder if needed
  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
  }

  const images = [];

  for (const pageNum of pageNumbers) {
    const outFile = path.join(tmpDir, `page_${pageNum}.png`);

    try {
      // Use Ghostscript to convert single page to image
      const cmd = `"${gsPath}" -dNOPAUSE -dBATCH -sDEVICE=png16m -r150 -dFirstPage=${pageNum} -dLastPage=${pageNum} -sOutputFile="${outFile}" "${pdfPath}"`;
      execSync(cmd, { stdio: 'ignore' });

      if (fs.existsSync(outFile)) {
        // Resize to reasonable size to save tokens
        const resized = await sharp(outFile)
          .resize({ width: 1200, withoutEnlargement: true })
          .png({ compressionLevel: 6 })
          .toBuffer();

        images.push({
          pageNum,
          base64: resized.toString('base64'),
          mediaType: 'image/png'
        });

        // Clean up temp file
        fs.unlinkSync(outFile);
      }
    } catch (err) {
      console.log(`[WARN] Could not convert page ${pageNum}: ${err.message}`);
    }
  }

  // Clean up temp folder if empty
  try { fs.rmdirSync(tmpDir); } catch {}

  return images;
}

// Figure out which page number a chunk came from
// based on character position in the document
export function estimatePageNumber(chunkIndex, totalChunks, totalPages) {
  return Math.max(1, Math.ceil((chunkIndex / totalChunks) * totalPages));
}