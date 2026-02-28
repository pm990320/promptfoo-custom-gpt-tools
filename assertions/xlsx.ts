import ExcelJS from 'exceljs';
import type { AssertionResult, XlsxAssertOptions, XlsxPreservedDataCheck } from '../src/types';

const ERROR_PATTERNS = ['#DIV/0!', '#REF!', '#N/A', '#NAME?', '#VALUE!', 'NAN'];

function fail(reason: string): AssertionResult {
  return { pass: false, score: 0, reason };
}

function normalizeValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'number' && Number.isNaN(value)) return 'NaN';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'object') {
    const asRecord = value as Record<string, unknown>;

    if (typeof asRecord.result === 'string' || typeof asRecord.result === 'number') {
      return String(asRecord.result).trim();
    }

    if (Array.isArray(asRecord.richText)) {
      return asRecord.richText
        .map((entry) => {
          if (entry && typeof entry === 'object' && 'text' in entry) {
            const text = (entry as { text?: unknown }).text;
            return typeof text === 'string' ? text : '';
          }
          return '';
        })
        .join('')
        .trim();
    }

    if (typeof asRecord.text === 'string') return asRecord.text.trim();
  }
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- deliberately stringifying unknown cell values
  return String(value).trim();
}

async function loadWorkbook(filePath: string): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  return workbook;
}

function checkPreservedData(
  outputWorkbook: ExcelJS.Workbook,
  referenceWorkbook: ExcelJS.Workbook,
  check: XlsxPreservedDataCheck,
): AssertionResult | undefined {
  const outputSheet = outputWorkbook.getWorksheet(check.sheet);
  const referenceSheet = referenceWorkbook.getWorksheet(check.sheet);

  if (!outputSheet) return fail(`Sheet not found in output workbook: ${check.sheet}`);
  if (!referenceSheet) return fail(`Sheet not found in reference workbook: ${check.sheet}`);

  for (let row = check.range.startRow; row <= check.range.endRow; row += 1) {
    for (let col = check.range.startCol; col <= check.range.endCol; col += 1) {
      const outVal = normalizeValue(outputSheet.getCell(row, col).value);
      const refVal = normalizeValue(referenceSheet.getCell(row, col).value);

      if (outVal !== refVal) {
        return fail(
          `Data mismatch at ${check.sheet}!R${row}C${col}. Expected "${refVal}", got "${outVal}"`,
        );
      }
    }
  }

  return undefined;
}

export async function xlsxAssert(filePath: string, options: XlsxAssertOptions = {}): Promise<AssertionResult> {
  const workbook = await loadWorkbook(filePath);

  if (typeof options.minSheets === 'number' && workbook.worksheets.length < options.minSheets) {
    return fail(`Expected at least ${options.minSheets} sheets, got ${workbook.worksheets.length}`);
  }

  if (typeof options.maxSheets === 'number' && workbook.worksheets.length > options.maxSheets) {
    return fail(`Expected at most ${options.maxSheets} sheets, got ${workbook.worksheets.length}`);
  }

  if (options.requiredSheets?.length) {
    const existing = new Set(workbook.worksheets.map((sheet) => sheet.name));
    for (const sheetName of options.requiredSheets) {
      if (!existing.has(sheetName)) {
        return fail(`Missing required sheet: ${sheetName}`);
      }
    }
  }

  if (options.columnExists) {
    const sheet = workbook.getWorksheet(options.columnExists.sheet);
    if (!sheet) return fail(`Sheet not found: ${options.columnExists.sheet}`);

    const target = options.columnExists.value.trim().toLowerCase();
    const row = sheet.getRow(options.columnExists.row);
    const rawValues = row.values;
    const rowValues: unknown[] = Array.isArray(rawValues)
      ? rawValues.slice(1)
      : Object.values(rawValues as Record<string, unknown>);

    const found = rowValues.some((cellValue: unknown) => normalizeValue(cellValue).toLowerCase() === target);

    if (!found) {
      return fail(
        `Value "${options.columnExists.value}" not found on row ${options.columnExists.row} in sheet ${options.columnExists.sheet}`,
      );
    }
  }

  if (options.noErrors) {
    for (const sheet of workbook.worksheets) {
      for (let row = 1; row <= sheet.rowCount; row += 1) {
        const worksheetRow = sheet.getRow(row);
        for (let col = 1; col <= worksheetRow.cellCount; col += 1) {
          const value = normalizeValue(worksheetRow.getCell(col).value).toUpperCase();
          if (!value) continue;
          if (ERROR_PATTERNS.some((pattern) => value.includes(pattern))) {
            return fail(`Found error-like value "${value}" at ${sheet.name}!R${row}C${col}`);
          }
        }
      }
    }
  }

  if (options.noEmptyCells) {
    const sheet = workbook.getWorksheet(options.noEmptyCells.sheet);
    if (!sheet) return fail(`Sheet not found: ${options.noEmptyCells.sheet}`);

    for (let row = options.noEmptyCells.startRow; row <= options.noEmptyCells.endRow; row += 1) {
      const value = normalizeValue(sheet.getCell(row, options.noEmptyCells.column).value);
      if (value === '') {
        return fail(
          `Empty cell found at ${options.noEmptyCells.sheet}!R${row}C${options.noEmptyCells.column}`,
        );
      }
    }
  }

  if (options.preservedData) {
    const referenceWorkbook = await loadWorkbook(options.preservedData.referenceFile);
    const preservedFailure = checkPreservedData(workbook, referenceWorkbook, options.preservedData);
    if (preservedFailure) return preservedFailure;
  }

  return { pass: true, score: 1 };
}
