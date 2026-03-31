# ============================================================
# PDF EXTRACTOR — uses pdfplumber for accurate extraction
# Extracts text, tables, and page numbers as structured JSON
# Also builds structured table data for keyword search
# Usage: python extract_pdf.py <pdf_path>
# ============================================================

import pdfplumber
import json
import sys
import os
import re

def classify_table(header, rows):
    """Classify table type based on header and content."""
    header_lower = ' '.join(str(h) for h in header).lower()
    
    if any(w in header_lower for w in ['part', 'sku', 'order', 'no.', 'p/n']):
        return 'parts'
    elif any(w in header_lower for w in ['spec', 'value', 'parameter', 'range']):
        return 'specs'
    elif any(w in header_lower for w in ['led', 'status', 'state', 'condition']):
        return 'status'
    elif any(w in header_lower for w in ['dimension', 'size', 'weight', 'height', 'width']):
        return 'dimensions'
    elif any(w in header_lower for w in ['error', 'fault', 'code', 'message']):
        return 'errors'
    else:
        return 'general'

def extract_table_data(table, page_num, filename):
    """Extract structured data from a table for keyword search."""
    if not table or len(table) < 2:
        return []
    
    header = [str(c).strip() if c else '' for c in table[0]]
    table_type = classify_table(header, table[1:])
    entries = []
    
    for row in table[1:]:
        cells = [str(c).strip() if c else '' for c in row]
        if not any(cells):
            continue
            
        entry = {
            'type': table_type,
            'page': page_num,
            'filename': filename,
            'cells': cells,
            'header': header,
        }
        
        # Add searchable fields based on type
        if table_type == 'parts' and len(cells) >= 2:
            entry['code'] = cells[0]
            entry['description'] = cells[1]
            entry['searchable'] = f"{cells[0]} {cells[1]} {' '.join(cells[2:])}"
            
        elif len(cells) >= 2:
            entry['key'] = cells[0]
            entry['value'] = cells[1]
            entry['extra'] = cells[2:] if len(cells) > 2 else []
            entry['searchable'] = ' '.join(c for c in cells if c)
        
        entries.append(entry)
    
    return entries

def extract_pdf(pdf_path):
    filename = os.path.basename(pdf_path)
    result = {
        "filename": filename,
        "pages": [],
        "table_data": []  # structured table data for keyword search
    }

    with pdfplumber.open(pdf_path) as pdf:
        total_pages = len(pdf.pages)
        result["total_pages"] = total_pages

        for page_num, page in enumerate(pdf.pages, start=1):
            page_data = {
                "page": page_num,
                "text": "",
                "tables": []
            }

            # Extract tables
            tables = page.extract_tables()
            for table in tables:
                if not table:
                    continue
                cleaned = []
                for row in table:
                    cleaned_row = [str(cell).strip() if cell else "" for cell in row]
                    if any(cell for cell in cleaned_row):
                        cleaned.append(cleaned_row)
                if cleaned:
                    page_data["tables"].append(cleaned)
                    # Extract structured data for keyword search
                    table_entries = extract_table_data(cleaned, page_num, filename)
                    result["table_data"].extend(table_entries)

            # Extract text
            try:
                text = page.extract_text(x_tolerance=3, y_tolerance=3)
                if text:
                    page_data["text"] = text.strip()
            except:
                page_data["text"] = ""

            result["pages"].append(page_data)

            if page_num % 10 == 0:
                print(f"  Processed {page_num}/{total_pages} pages...", file=sys.stderr)

    return result

def is_comparison_table(table):
    """
    Generic detection of comparison tables.
    Works for any product/model comparison, not just VESDA.
    Detects two layouts:
    - row_per_model: each row is a different product/model
    - col_per_model: each column is a different product/model
    """
    if not table or len(table) < 3:
        return False

    # ── Check row_per_model ──
    first_col = [str(row[0]).strip() for row in table[1:] if row and str(row[0]).strip()]
    if len(first_col) >= 2:
        avg_length = sum(len(v) for v in first_col) / len(first_col)
        all_short = avg_length < 30
        has_multiple_cols = len(table[0]) >= 3 if table[0] else False
        not_sentences = all(len(v.split()) <= 5 for v in first_col)
        lengths = [len(v) for v in first_col]
        consistent = (max(lengths) - min(lengths) < 25) if lengths else False
        if all_short and has_multiple_cols and not_sentences and consistent:
            return 'row_per_model'

    # ── Check col_per_model ──
    if table[0]:
        header_cols = [str(c).strip() for c in table[0][1:] if str(c).strip()]
        if len(header_cols) >= 2:
            avg_length = sum(len(v) for v in header_cols) / len(header_cols)
            all_short = avg_length < 30
            not_sentences = all(len(v.split()) <= 5 for v in header_cols)
            lengths = [len(v) for v in header_cols]
            consistent = (max(lengths) - min(lengths) < 25) if lengths else False
            if all_short and not_sentences and consistent and len(table) >= 3:
                return 'col_per_model'

    return False


def explode_comparison_table(table):
    """Convert comparison table into per-model fact statements."""
    table_type = is_comparison_table(table)
    if not table_type:
        return ""

    facts = []

    if table_type == 'row_per_model':
        headers = [str(c).strip() for c in table[0]] if table else []
        for row in table[1:]:
            if not row:
                continue
            model = str(row[0]).strip()
            if not model:
                continue
            for i, cell in enumerate(row[1:], start=1):
                value = str(cell).strip() if cell else ""
                attribute = headers[i] if i < len(headers) else ""
                if attribute and value and value.lower() not in ['', '-', 'n/a', 'none']:
                    facts.append(f"{model} {attribute} is {value}.")

    elif table_type == 'col_per_model':
        models = [str(c).strip() for c in table[0][1:]] if table[0] else []
        for row in table[1:]:
            if not row:
                continue
            attribute = str(row[0]).strip()
            if not attribute:
                continue
            for i, model in enumerate(models):
                value = str(row[i + 1]).strip() if i + 1 < len(row) else ""
                if model and value and value.lower() not in ['', '-', 'n/a', 'none']:
                    facts.append(f"{model} {attribute} is {value}.")

    return "\n".join(facts)


def generate_table_qa(table):
    """Convert ANY table into searchable Q&A sentences."""
    if not table or len(table) < 2:
        return ""

    qa_lines = []
    header = [str(c).strip() for c in table[0]] if table else []
    has_header = any(h for h in header)
    header_lower = ' '.join(header).lower()
    is_parts_table = any(w in header_lower for w in
        ['part', 'sku', 'order', 'no.', 'number', 'code', 'p/n'])

    for row in table[1:]:
        cells = [str(c).strip() for c in row]
        non_empty = [c for c in cells if c]
        if len(non_empty) < 2:
            continue

        if is_parts_table and len(cells) >= 2:
            code = cells[0].strip()
            description = cells[1].strip() if len(cells) > 1 else ""
            if code and description:
                qa_lines.append(f"Part number for {description} is {code}.")
                qa_lines.append(f"SKU {code} is {description}.")
                qa_lines.append(f"{description} part number: {code}.")
        elif has_header and len(header) >= 2:
            row_label = cells[0] if cells else ""
            for i, cell in enumerate(cells[1:], start=1):
                if not cell:
                    continue
                col_header = header[i] if i < len(header) else ""
                if col_header and row_label:
                    qa_lines.append(f"{row_label} {col_header} is {cell}.")
                elif col_header:
                    qa_lines.append(f"{col_header} is {cell}.")
        else:
            qa_lines.append(". ".join(c for c in cells if c) + ".")

    return "\n".join(qa_lines) if qa_lines else ""

def format_for_rag(extracted):
    """Convert extracted PDF data into RAG-friendly format."""
    rag_pages = []

    for page_data in extracted["pages"]:
        page_num = page_data["page"]
        chunks = []

        if page_data["text"]:
            chunks.append(page_data["text"])

        for table in page_data["tables"]:
            if not table:
                continue
            table_lines = []
            for row in table:
                if not any(cell.strip() for cell in row):
                    continue
                row_text = " | ".join(cell for cell in row if cell.strip())
                if row_text:
                    table_lines.append(row_text)

            if table_lines:
                table_text = "\n".join(table_lines)
                chunks.append(f"[TABLE]\n{table_text}\n[/TABLE]")

                # Try comparison table explosion first
                comparison_facts = explode_comparison_table(table)
                if comparison_facts:
                    # Store as separate dedicated entry for better embeddings
                    rag_pages.append({
                        "page": page_num,
                        "content": comparison_facts,
                        "is_facts": True
                    })
                else:
                    # Fall back to general Q&A pairs
                    qa_text = generate_table_qa(table)
                    if qa_text:
                        chunks.append(qa_text)

        if chunks:
            rag_pages.append({
                "page": page_num,
                "content": "\n\n".join(chunks)
            })

    return {
        "filename": extracted["filename"],
        "total_pages": extracted["total_pages"],
        "pages": rag_pages,
        "table_data": extracted["table_data"]
    }

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python extract_pdf.py <pdf_path>", file=sys.stderr)
        sys.exit(1)

    pdf_path = sys.argv[1]

    if not os.path.exists(pdf_path):
        print(f"Error: File not found: {pdf_path}", file=sys.stderr)
        sys.exit(1)

    print(f"Extracting: {os.path.basename(pdf_path)}", file=sys.stderr)
    extracted = extract_pdf(pdf_path)
    rag_data = format_for_rag(extracted)

    sys.stdout.buffer.write(json.dumps(rag_data, ensure_ascii=False).encode('utf-8'))