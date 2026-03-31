import fs from 'fs';
import path from 'path';
import pdf from 'pdf-parse/lib/pdf-parse.js';

const manualsDir = path.join(process.cwd(), 'manuals');
const files = fs.readdirSync(manualsDir).filter(f => f.endsWith('.pdf'));
console.log('Found:', files.length, 'PDFs');
const buf = fs.readFileSync(path.join(manualsDir, files[0]));
console.log('Read file OK, size:', buf.length);
const data = await pdf(buf);
console.log('Parsed OK, pages:', data.numpages);
console.log('Text length:', data.text.length);