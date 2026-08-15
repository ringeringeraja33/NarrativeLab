/**
 * PDF export settings used by desktop print-to-PDF.
 * Generation itself runs through Electron's printToPDF in ExportService.
 */

export interface SLPdfSettings {
    fontFamily: 'Helvetica' | 'TimesRoman' | 'Courier';
    fontSize: number;            // base body font size in pt
    pageSize: 'A4' | 'A5' | 'A3' | 'Letter' | 'Legal';
    marginTop: number;           // pt
    marginBottom: number;
    marginLeft: number;
    marginRight: number;
    lineSpacing: number;         // multiplier (1.0 = single, 1.5, 2.0 = double)
    includeMetadata: boolean;    // include frontmatter
    includePageNumbers: boolean;
    headerFontSize: number;      // for the project title on page 1
}

export const SL_DEFAULT_PDF_SETTINGS: SLPdfSettings = {
    fontFamily: 'Helvetica',
    fontSize: 11,
    pageSize: 'A4',
    marginTop: 72,       // 1 inch
    marginBottom: 72,
    marginLeft: 72,
    marginRight: 72,
    lineSpacing: 1.4,
    includeMetadata: false,
    includePageNumbers: true,
    headerFontSize: 24,
};
